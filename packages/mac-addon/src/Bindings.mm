#include <napi.h>

#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <unistd.h>

#include <string>
#include <utility>
#include <vector>

#include "CameraPreview.h"
#include "Common.h"
#include "Devices.h"
#include "Events.h"
#include "Permissions.h"
#include "RecorderSession.h"
#include "RecordingWorkers.h"
#include "ScreenTrack.h"

static RecordingOptions ParseRecordingOptions(const Napi::CallbackInfo &info) {
  RecordingOptions options;
  options.sessionId = NewSessionId();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return options;
  }

  Napi::Object object = info[0].As<Napi::Object>();
  options.outputDir = GetStringProp(object, "outputDir");
  options.basename = GetStringProp(object, "basename");
  options.fps = GetIntProp(object, "fps", 60);
  if (options.fps != 30 && options.fps != 60) {
    options.fps = 60;
  }
  options.width = GetIntProp(object, "width", 0);
  options.height = GetIntProp(object, "height", 0);
  options.includeCursor = GetBoolProp(object, "includeCursor", true);
  options.recordSystemAudio = GetBoolProp(object, "recordSystemAudio", true);
  options.recordMicrophone = GetBoolProp(object, "recordMicrophone", false);
  options.recordCamera = GetBoolProp(object, "recordCamera", false);
  options.excludeOwnApp = GetBoolProp(object, "excludeOwnApp", true);
  options.microphoneDeviceId = GetStringProp(object, "microphoneDeviceId");
  options.cameraDeviceId = GetStringProp(object, "cameraDeviceId");

  // Input capture (mouse / keystrokes / cursor shapes) → Screen Studio-style
  // sidecar JSON. captureKeyStrokes / captureCursorShapes imply captureInput.
  options.captureInput = GetBoolProp(object, "captureInput", false);
  options.captureKeyStrokes = GetBoolProp(object, "captureKeyStrokes", false);
  options.captureCursorShapes = GetBoolProp(object, "captureCursorShapes", false);
  if (options.captureKeyStrokes || options.captureCursorShapes) {
    options.captureInput = true;
  }

  // Screen video quality settings (all optional; ScreenTrack coerces invalid
  // combinations before recording starts so AVAssetWriter never sees a
  // configuration it would reject).
  options.videoCodec = GetStringProp(object, "videoCodec");
  options.videoQuality = GetStringProp(object, "videoQuality", "high");
  options.container = GetStringProp(object, "container", "mov");
  options.resolutionMode = GetStringProp(object, "resolutionMode", "native");
  options.frameRate = GetIntProp(object, "frameRate", -1);
  // Mirror frameRate→fps so legacy code paths that read `fps` (manifest,
  // logging) still see the user's choice. A `frameRate` of 0 means "native"
  // (120 timescale); -1 means "not provided, use fps".
  if (options.frameRate == 0) {
    // Leave fps at its existing value (used for bitrate budget; native frame
    // rate is treated as an upper bound rather than a guaranteed rate).
  } else if (options.frameRate > 0) {
    options.fps = options.frameRate;
  }

  Napi::Value audioAppsValue = object.Get("audioApplications");
  if (audioAppsValue.IsArray()) {
    Napi::Array audioApps = audioAppsValue.As<Napi::Array>();
    for (uint32_t i = 0; i < audioApps.Length(); ++i) {
      Napi::Value entry = audioApps.Get(i);
      if (!entry.IsString()) continue;
      std::string bundleId = entry.As<Napi::String>().Utf8Value();
      if (bundleId.empty()) continue;
      options.audioApplicationBundleIds.push_back(std::move(bundleId));
    }
  }

  Napi::Value targetValue = object.Get("target");
  if (targetValue.IsObject()) {
    Napi::Object target = targetValue.As<Napi::Object>();
    options.target.type = GetStringProp(target, "type", "display");
    options.target.displayId = GetUint32Prop(target, "displayId", 0);
    options.target.windowId = GetUint32Prop(target, "windowId", 0);
    options.target.bundleId = GetStringProp(target, "bundleId");
    options.target.title = GetStringProp(target, "title");
    options.target.applicationName = GetStringProp(target, "applicationName");
    options.target.processId = GetIntProp(target, "processId", 0);
    options.target.x = GetDoubleProp(target, "x", 0);
    options.target.y = GetDoubleProp(target, "y", 0);
    options.target.width = GetDoubleProp(target, "width", 0);
    options.target.height = GetDoubleProp(target, "height", 0);
    options.target.sourceX = GetDoubleProp(target, "sourceX", 0);
    options.target.sourceY = GetDoubleProp(target, "sourceY", 0);
    options.target.sourceWidth = GetDoubleProp(target, "sourceWidth", 0);
    options.target.sourceHeight = GetDoubleProp(target, "sourceHeight", 0);
    options.target.scaleFactor = GetDoubleProp(target, "scaleFactor", 0);
  }

  return options;
}

static CGPoint CurrentCursorPoint() {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = event ? CGEventGetLocation(event) : CGPointZero;
  if (event) CFRelease(event);
  return point;
}

static bool CGRectFromWindowDictionary(NSDictionary *dictionary, CGRect *rect) {
  id boundsValue = dictionary[(id)kCGWindowBounds];
  if (!boundsValue) return false;
  return CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsValue, rect);
}

// Bounded LRU cache for app-icon data URLs keyed by pid. PIDs are recycled by
// the OS, so an unbounded cache would slowly grow over a long-running session
// and occasionally surface a stale icon when a pid is reused. The LRU bound
// caps both. Insertion order is tracked in gIconOrder; on eviction we drop
// the oldest entry.
//
// Thread: all entry points (ListVisibleWindows / GetWindowUnderCursor) are
// invoked from the NAPI/JS thread, so this state is single-threaded.
static const NSUInteger kIconCacheCap = 256;
static NSMutableDictionary<NSNumber *, NSString *> *gIconCache = nil;
static NSMutableArray<NSNumber *> *gIconOrder = nil;

static NSString *IconDataURLForProcess(pid_t pid) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    gIconCache = [NSMutableDictionary dictionaryWithCapacity:kIconCacheCap];
    gIconOrder = [NSMutableArray arrayWithCapacity:kIconCacheCap];
  });

  NSNumber *key = @(pid);
  NSString *cached = gIconCache[key];
  if (cached) return cached;

  NSRunningApplication *app =
      [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  NSImage *icon = app.icon;
  if (!icon) return nil;

  NSData *tiff = [icon TIFFRepresentation];
  if (!tiff) return nil;
  NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:tiff];
  if (!rep) return nil;
  NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png) return nil;
  NSString *dataURL = [NSString stringWithFormat:@"data:image/png;base64,%@",
                                                 [png base64EncodedStringWithOptions:0]];

  if (gIconCache.count >= kIconCacheCap && gIconOrder.count > 0) {
    NSNumber *oldest = gIconOrder.firstObject;
    [gIconOrder removeObjectAtIndex:0];
    [gIconCache removeObjectForKey:oldest];
  }
  gIconCache[key] = dataURL;
  [gIconOrder addObject:key];
  return dataURL;
}

static Napi::Value WindowSourceToNapi(Napi::Env env,
                                      NSDictionary *windowInfo,
                                      CGRect bounds,
                                      bool includeIcon) {
  NSNumber *windowNumber = windowInfo[(id)kCGWindowNumber];
  NSNumber *ownerPid = windowInfo[(id)kCGWindowOwnerPID];
  NSString *title = windowInfo[(id)kCGWindowName] ?: @"";
  NSString *ownerName = windowInfo[(id)kCGWindowOwnerName] ?: @"";
  pid_t pid = ownerPid ? ownerPid.intValue : 0;
  NSRunningApplication *app =
      pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
  NSString *applicationName = ownerName.length > 0
      ? ownerName
      : (app.localizedName ?: @"");
  NSString *bundleIdentifier = app.bundleIdentifier ?: @"";

  Napi::Object item = Napi::Object::New(env);
  item.Set("windowId", windowNumber ? windowNumber.unsignedIntValue : 0);
  item.Set("title", ToStdString(title));
  item.Set("onScreen", true);
  item.Set("x", bounds.origin.x);
  item.Set("y", bounds.origin.y);
  item.Set("width", bounds.size.width);
  item.Set("height", bounds.size.height);
  item.Set("applicationName", ToStdString(applicationName));
  item.Set("bundleId", ToStdString(bundleIdentifier));
  item.Set("processId", pid);
  if (includeIcon && pid > 0) {
    NSString *iconDataUrl = IconDataURLForProcess(pid);
    if (iconDataUrl.length > 0) {
      item.Set("iconDataUrl", ToStdString(iconDataUrl));
    }
  }
  return item;
}

static Napi::Value DisplaySourceToNapi(Napi::Env env, CGDirectDisplayID displayID) {
  CGRect bounds = CGDisplayBounds(displayID);
  Napi::Object item = Napi::Object::New(env);
  item.Set("displayId", displayID);
  item.Set("width", (double)CGDisplayPixelsWide(displayID));
  item.Set("height", (double)CGDisplayPixelsHigh(displayID));
  item.Set("x", bounds.origin.x);
  item.Set("y", bounds.origin.y);
  return item;
}

static bool IsIgnoredBundleIdentifier(NSString *bundleIdentifier) {
  if (bundleIdentifier.length == 0) return false;
  static NSSet<NSString *> *ignoredBundles = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    ignoredBundles = [NSSet setWithArray:@[
      @"com.apple.dock",
      @"com.apple.finder.desktop",
      @"com.apple.notificationcenterui",
      @"com.apple.WindowManager",
      @"com.apple.controlcenter"
    ]];
  });
  return [ignoredBundles containsObject:bundleIdentifier];
}

// Minimum on-screen size for a window to be considered pickable. Anything
// smaller is almost certainly chrome (status bar tile, tooltip, picker
// indicator) rather than a window a user wants to record. The bound is
// intentionally small enough to admit Music's mini player and palette
// windows while still rejecting OS-level decorations.
static const CGFloat kPickableMinWidth  = 120;
static const CGFloat kPickableMinHeight = 80;
// Treat anything with alpha <= 5% as effectively invisible; macOS uses
// 0-alpha placeholder windows for things like menu-extras and overlays.
static const CGFloat kPickableMinAlpha  = 0.05;

static bool PickableWindowInfo(NSDictionary *windowInfo,
                               pid_t ownPid,
                               NSString *ownBundleId,
                               CGRect *outBounds) {
  NSNumber *windowNumber = windowInfo[(id)kCGWindowNumber];
  NSNumber *layer = windowInfo[(id)kCGWindowLayer];
  NSNumber *ownerPid = windowInfo[(id)kCGWindowOwnerPID];
  NSNumber *alpha = windowInfo[(id)kCGWindowAlpha];
  if (!windowNumber || !layer || layer.integerValue != 0) return false;

  pid_t pid = ownerPid ? ownerPid.intValue : 0;
  if (pid == ownPid) return false;
  if (alpha && alpha.doubleValue <= kPickableMinAlpha) return false;

  CGRect bounds = CGRectZero;
  if (!CGRectFromWindowDictionary(windowInfo, &bounds)) return false;
  if (bounds.size.width < kPickableMinWidth ||
      bounds.size.height < kPickableMinHeight) return false;

  NSRunningApplication *app =
      pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
  NSString *bundleIdentifier = app.bundleIdentifier ?: @"";
  if (ownBundleId.length > 0 && [bundleIdentifier isEqualToString:ownBundleId]) {
    return false;
  }
  if (IsIgnoredBundleIdentifier(bundleIdentifier)) return false;

  if (outBounds) *outBounds = bounds;
  return true;
}

static NSArray *CopyOnScreenWindowInfo() {
  CFArrayRef rawWindows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  return CFBridgingRelease(rawWindows);
}

static Napi::Value GetWindowUnderCursor(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!CGPreflightScreenCaptureAccess()) {
    return env.Null();
  }

  bool includeIcon = true;
  if (info.Length() > 0 && info[0].IsBoolean()) {
    includeIcon = info[0].As<Napi::Boolean>().Value();
  }

  CGPoint cursor = CurrentCursorPoint();
  NSArray *windows = CopyOnScreenWindowInfo();
  pid_t ownPid = getpid();
  NSString *ownBundleId = [[NSBundle mainBundle] bundleIdentifier];
  NSDictionary *candidateWindowInfo = nil;
  CGRect candidateBounds = CGRectNull;

  for (NSDictionary *windowInfo in windows) {
    CGRect bounds = CGRectZero;
    if (!PickableWindowInfo(windowInfo, ownPid, ownBundleId, &bounds)) continue;
    if (!CGRectContainsPoint(bounds, cursor)) continue;

    candidateWindowInfo = windowInfo;
    candidateBounds = bounds;
    break;
  }

  if (!candidateWindowInfo) return env.Null();
  return WindowSourceToNapi(env, candidateWindowInfo, candidateBounds, includeIcon);
}

static Napi::Value ListVisibleWindows(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);
  if (!CGPreflightScreenCaptureAccess()) {
    return result;
  }

  bool includeIcons = false;
  if (info.Length() > 0 && info[0].IsBoolean()) {
    includeIcons = info[0].As<Napi::Boolean>().Value();
  }

  NSArray *windows = CopyOnScreenWindowInfo();
  pid_t ownPid = getpid();
  NSString *ownBundleId = [[NSBundle mainBundle] bundleIdentifier];
  uint32_t index = 0;

  for (NSDictionary *windowInfo in windows) {
    CGRect bounds = CGRectZero;
    if (!PickableWindowInfo(windowInfo, ownPid, ownBundleId, &bounds)) continue;
    result.Set(index++, WindowSourceToNapi(env, windowInfo, bounds, includeIcons));
  }

  return result;
}

static Napi::Value GetDisplayUnderCursor(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!CGPreflightScreenCaptureAccess()) {
    return env.Null();
  }

  CGPoint cursor = CurrentCursorPoint();
  uint32_t displayCount = 0;
  CGGetActiveDisplayList(0, nullptr, &displayCount);
  if (displayCount == 0) return env.Null();

  std::vector<CGDirectDisplayID> displays(displayCount);
  CGGetActiveDisplayList(displayCount, displays.data(), &displayCount);
  for (uint32_t i = 0; i < displayCount; ++i) {
    CGDirectDisplayID displayID = displays[i];
    if (CGRectContainsPoint(CGDisplayBounds(displayID), cursor)) {
      return DisplaySourceToNapi(env, displayID);
    }
  }

  return env.Null();
}

static Napi::Value Hello(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), "Hello, World from macOS native addon!");
}

static Napi::Value GetCapabilities(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  NSOperatingSystemVersion version =
      [[NSProcessInfo processInfo] operatingSystemVersion];
  Napi::Object result = Napi::Object::New(env);
  result.Set("platform", "darwin");
  result.Set("macosVersion", [NSString stringWithFormat:@"%ld.%ld.%ld",
                              (long)version.majorVersion,
                              (long)version.minorVersion,
                              (long)version.patchVersion].UTF8String);
  result.Set("screenCaptureKit", true);
  result.Set("systemAudio", true);
  // SCStream-based microphone capture (`captureMicrophone`) is macOS 15+.
  result.Set("screenCaptureKitMicrophone",
             IsMacOSAtLeast(15) ? Napi::Boolean::New(env, true)
                                 : Napi::Boolean::New(env, false));
  result.Set("microphoneFallback", false);
  result.Set("camera", true);
  result.Set("separateFiles", false);
  result.Set("scRecordingOutput",
             IsMacOSAtLeast(15) ? Napi::Boolean::New(env, true)
                                 : Napi::Boolean::New(env, false));
  return result;
}

static Napi::Value GetPermissions(const Napi::CallbackInfo &info) {
  return GetPermissionsObject(info.Env());
}

static Napi::Value RequestPermissions(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::vector<std::string> kinds;

  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array array = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < array.Length(); ++i) {
      Napi::Value value = array.Get(i);
      if (value.IsString()) {
        kinds.push_back(value.As<Napi::String>().Utf8Value());
      }
    }
  }

  auto *worker = new RequestPermissionsWorker(env, std::move(kinds));
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value ListShareableContent(const Napi::CallbackInfo &info) {
  auto *worker = new ListShareableContentWorker(info.Env());
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value ListCameras(const Napi::CallbackInfo &info) {
  return ListDevicesValue(info, AVMediaTypeVideo);
}

static Napi::Value ListMicrophones(const Napi::CallbackInfo &info) {
  return ListDevicesValue(info, AVMediaTypeAudio);
}

static Napi::Value StartRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  RecordingOptions options = ParseRecordingOptions(info);

  auto reject = [&](const std::string &message) {
    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, message).Value());
    return deferred.Promise();
  };

  if (options.outputDir.empty()) {
    return reject("startRecording requires outputDir");
  }

  if (options.target.type == "region" &&
      (options.target.displayId == 0 ||
       options.target.width <= 0 ||
       options.target.height <= 0)) {
    return reject("Region recording requires displayId, width, and height");
  }

  BOOL isDirectory = NO;
  NSString *outputPath = ToNSString(options.outputDir);
  if ([[NSFileManager defaultManager] fileExistsAtPath:outputPath
                                           isDirectory:&isDirectory] &&
      !isDirectory) {
    return reject("outputDir exists but is not a directory");
  }

  if (!CGPreflightScreenCaptureAccess()) {
    return reject("Screen Recording permission is not granted");
  }

  if (options.recordCamera &&
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo] !=
          AVAuthorizationStatusAuthorized) {
    return reject("Camera permission is not granted");
  }

  if (options.recordMicrophone &&
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] !=
          AVAuthorizationStatusAuthorized) {
    return reject("Microphone permission is not granted");
  }

  RecorderSession *session = [[RecorderSession alloc] initWithOptions:options];
  StoreSession(session);

  auto *worker = new StartRecordingWorker(env, options.sessionId);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value StopRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string sessionId;
  if (info.Length() > 0 && info[0].IsString()) {
    sessionId = info[0].As<Napi::String>().Utf8Value();
  }
  auto *worker = new StopRecordingWorker(env, sessionId);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value CancelRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string sessionId;
  if (info.Length() > 0 && info[0].IsString()) {
    sessionId = info[0].As<Napi::String>().Utf8Value();
  }
  auto *worker = new CancelRecordingWorker(env, sessionId);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// Pause / resume run synchronously — they only toggle flags on each track and
// emit an event, so there's no benefit to going through AsyncWorker. The
// returned object reports the current paused state and total paused
// milliseconds so the JS side can drive a timer off it.
static Napi::Object PauseStateResult(Napi::Env env, RecorderSession *session) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("sessionId", ToStdString([session sessionId]));
  result.Set("paused", [session isPaused]);
  result.Set("pausedMs", [session pausedMs]);
  return result;
}

static Napi::Value PauseRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "pauseRecording requires a sessionId")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  RecorderSession *session = GetSession(sessionId);
  if (!session) {
    Napi::Error::New(env, "Unknown recording session").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSError *pauseError = nil;
  if (![session pauseSync:&pauseError]) {
    NSString *message = pauseError.localizedDescription ?: @"Could not pause recording";
    Napi::Error::New(env, ToStdString(message)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return PauseStateResult(env, session);
}

static Napi::Value ResumeRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "resumeRecording requires a sessionId")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  RecorderSession *session = GetSession(sessionId);
  if (!session) {
    Napi::Error::New(env, "Unknown recording session").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSError *resumeError = nil;
  if (![session resumeSync:&resumeError]) {
    NSString *message = resumeError.localizedDescription ?: @"Could not resume recording";
    Napi::Error::New(env, ToStdString(message)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return PauseStateResult(env, session);
}

static Napi::Value RecordingStatus(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "getRecordingStatus requires a sessionId")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  RecorderSession *session = GetSession(sessionId);
  if (!session) return env.Null();
  return PauseStateResult(env, session);
}

static Napi::Value OnRecordingEvent(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "onRecordingEvent requires a callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return InstallEventCallback(env, info[0].As<Napi::Function>());
}

static Napi::Value StartCameraPreview(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startCameraPreview(options, callback) requires an options object and a callback")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo] !=
      AVAuthorizationStatusAuthorized) {
    Napi::Error::New(env, "Camera permission is not granted").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object options = info[0].As<Napi::Object>();
  std::string deviceId = GetStringProp(options, "deviceId");

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "OpenScreenCameraPreview", 4, 1);

  auto *worker = new StartCameraPreviewWorker(
      env, std::move(deviceId), tsfn, NextPreviewGeneration());
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value StopCameraPreview(const Napi::CallbackInfo &info) {
  auto *worker = new StopCameraPreviewWorker(info.Env(), NextPreviewGeneration());
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// Drive NSWindow.collectionBehavior directly. Electron's
// setVisibleOnAllWorkspaces sets only CanJoinAllSpaces, and that flag is
// silently cleared by AppKit on level changes, setBounds, and some show/hide
// transitions. Re-asserting the full mask here — including
// FullScreenAuxiliary (visible over fullscreen Spaces) and Stationary (don't
// follow the active Space, just be on every one) — keeps the overlay pinned
// reliably. Pass the Buffer returned by BrowserWindow.getNativeWindowHandle().
static Napi::Value PinWindowAcrossSpaces(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "pinWindowAcrossSpaces(handle) requires a Buffer")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Buffer<uint8_t> handleBuffer = info[0].As<Napi::Buffer<uint8_t>>();
  if (handleBuffer.Length() < sizeof(void *)) {
    Napi::TypeError::New(env, "Native window handle is too small")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  void *raw = *reinterpret_cast<void **>(handleBuffer.Data());
  NSView *view = (__bridge NSView *)raw;
  NSWindow *window = view.window;
  if (!window) return Napi::Boolean::New(env, false);

  dispatch_block_t apply = ^{
    // CanJoinAllSpaces and Stationary belong to mutually-exclusive groups in
    // AppKit's collectionBehavior model: CanJoinAllSpaces puts the window on
    // every Space, Stationary makes the window participate in no Space
    // management at all (like the desktop picture). Combining them produced
    // the intermittent "sometimes visible, sometimes not" behavior the user
    // reported — leave Stationary out and stick to the canonical follow-me
    // mask. FullScreenAuxiliary lets the panel float over fullscreen Spaces;
    // IgnoresCycle keeps it out of cmd-` window cycling.
    NSWindowCollectionBehavior behavior =
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary |
        NSWindowCollectionBehaviorIgnoresCycle;
    window.collectionBehavior = behavior;
  };
  if ([NSThread isMainThread]) {
    apply();
  } else {
    dispatch_sync(dispatch_get_main_queue(), apply);
  }
  return Napi::Boolean::New(env, true);
}

static Napi::ThreadSafeFunction gSpaceChangeTsfn;
static id gSpaceChangeObserver = nil;

static Napi::Value OnActiveSpaceChange(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "onActiveSpaceChange(callback) requires a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (gSpaceChangeObserver) {
    [[[NSWorkspace sharedWorkspace] notificationCenter] removeObserver:gSpaceChangeObserver];
    gSpaceChangeObserver = nil;
  }
  if (gSpaceChangeTsfn) {
    gSpaceChangeTsfn.Release();
  }

  gSpaceChangeTsfn = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "OpenScreenSpaceChange", 0, 1);

  gSpaceChangeObserver = [[[NSWorkspace sharedWorkspace] notificationCenter]
      addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *_Nonnull notification) {
                gSpaceChangeTsfn.NonBlockingCall([](Napi::Env env, Napi::Function jsCallback) {
                  jsCallback.Call({});
                });
              }];
  return env.Undefined();
}

// Fire-and-forget background fetch of SCShareableContent so the next
// startRecording can skip the 500ms–1s wait. Idempotent and cheap to call
// from multiple places (recorder bar open, picker open).
static Napi::Value PrewarmShareableContent(const Napi::CallbackInfo &info) {
  [ScreenTrack prewarmShareableContent];
  return info.Env().Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("hello", Napi::Function::New(env, Hello));
  exports.Set("prewarmShareableContent",
              Napi::Function::New(env, PrewarmShareableContent));
  exports.Set("getCapabilities", Napi::Function::New(env, GetCapabilities));
  exports.Set("getPermissions", Napi::Function::New(env, GetPermissions));
  exports.Set("requestPermissions", Napi::Function::New(env, RequestPermissions));
  exports.Set("listShareableContent", Napi::Function::New(env, ListShareableContent));
  exports.Set("listVisibleWindows", Napi::Function::New(env, ListVisibleWindows));
  exports.Set("getWindowUnderCursor", Napi::Function::New(env, GetWindowUnderCursor));
  exports.Set("getDisplayUnderCursor", Napi::Function::New(env, GetDisplayUnderCursor));
  exports.Set("listCameras", Napi::Function::New(env, ListCameras));
  exports.Set("listMicrophones", Napi::Function::New(env, ListMicrophones));
  exports.Set("startRecording", Napi::Function::New(env, StartRecording));
  exports.Set("stopRecording", Napi::Function::New(env, StopRecording));
  exports.Set("cancelRecording", Napi::Function::New(env, CancelRecording));
  exports.Set("pauseRecording", Napi::Function::New(env, PauseRecording));
  exports.Set("resumeRecording", Napi::Function::New(env, ResumeRecording));
  exports.Set("getRecordingStatus", Napi::Function::New(env, RecordingStatus));
  exports.Set("onRecordingEvent", Napi::Function::New(env, OnRecordingEvent));
  exports.Set("startCameraPreview", Napi::Function::New(env, StartCameraPreview));
  exports.Set("stopCameraPreview", Napi::Function::New(env, StopCameraPreview));
  exports.Set("pinWindowAcrossSpaces", Napi::Function::New(env, PinWindowAcrossSpaces));
  exports.Set("onActiveSpaceChange", Napi::Function::New(env, OnActiveSpaceChange));
  return exports;
}

NODE_API_MODULE(mac_addon, Init)
