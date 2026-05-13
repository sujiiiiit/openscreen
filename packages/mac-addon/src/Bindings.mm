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

static RecordingOptions ParseRecordingOptions(const Napi::CallbackInfo &info) {
  RecordingOptions options;
  options.sessionId = NewSessionId();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return options;
  }

  Napi::Object object = info[0].As<Napi::Object>();
  options.outputDir = GetStringProp(object, "outputDir");
  options.basename = GetStringProp(object, "basename");
  options.fps = GetIntProp(object, "fps", 30);
  if (options.fps != 60) {
    options.fps = 30;
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

static NSString *IconDataURLForProcess(pid_t pid) {
  static NSMutableDictionary<NSNumber *, NSString *> *cache = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    cache = [NSMutableDictionary dictionary];
  });

  NSNumber *key = @(pid);
  NSString *cached = cache[key];
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
  cache[key] = dataURL;
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
  CFArrayRef rawWindows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  NSArray *windows = CFBridgingRelease(rawWindows);
  pid_t ownPid = getpid();
  NSDictionary *candidateWindowInfo = nil;
  CGRect candidateBounds = CGRectNull;

  for (NSDictionary *windowInfo in windows) {
    NSNumber *windowNumber = windowInfo[(id)kCGWindowNumber];
    NSNumber *layer = windowInfo[(id)kCGWindowLayer];
    NSNumber *ownerPid = windowInfo[(id)kCGWindowOwnerPID];
    NSNumber *alpha = windowInfo[(id)kCGWindowAlpha];
    if (!windowNumber || !layer || layer.integerValue != 0) continue;
    pid_t pid = ownerPid ? ownerPid.intValue : 0;
    if (pid == ownPid) continue;
    if (alpha && alpha.doubleValue <= 0.05) continue;

    CGRect bounds = CGRectZero;
    if (!CGRectFromWindowDictionary(windowInfo, &bounds)) continue;
    if (bounds.size.width < 320 || bounds.size.height < 220) continue;
    if (!CGRectContainsPoint(bounds, cursor)) continue;

    NSRunningApplication *app =
        pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
    NSString *bundleIdentifier = app.bundleIdentifier ?: @"";
    NSString *ownBundleId = [[NSBundle mainBundle] bundleIdentifier];
    if (ownBundleId.length > 0 && [bundleIdentifier isEqualToString:ownBundleId]) continue;
    if (IsIgnoredBundleIdentifier(bundleIdentifier)) continue;

    candidateWindowInfo = windowInfo;
    candidateBounds = bounds;
    break;
  }

  if (!candidateWindowInfo) return env.Null();
  return WindowSourceToNapi(env, candidateWindowInfo, candidateBounds, includeIcon);
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
  result.Set("screenCaptureKitMicrophone", true);
  result.Set("microphoneFallback", false);
  result.Set("camera", true);
  result.Set("separateFiles", false);
  result.Set("scRecordingOutput", true);
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

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("hello", Napi::Function::New(env, Hello));
  exports.Set("getCapabilities", Napi::Function::New(env, GetCapabilities));
  exports.Set("getPermissions", Napi::Function::New(env, GetPermissions));
  exports.Set("requestPermissions", Napi::Function::New(env, RequestPermissions));
  exports.Set("listShareableContent", Napi::Function::New(env, ListShareableContent));
  exports.Set("getWindowUnderCursor", Napi::Function::New(env, GetWindowUnderCursor));
  exports.Set("getDisplayUnderCursor", Napi::Function::New(env, GetDisplayUnderCursor));
  exports.Set("listCameras", Napi::Function::New(env, ListCameras));
  exports.Set("listMicrophones", Napi::Function::New(env, ListMicrophones));
  exports.Set("startRecording", Napi::Function::New(env, StartRecording));
  exports.Set("stopRecording", Napi::Function::New(env, StopRecording));
  exports.Set("cancelRecording", Napi::Function::New(env, CancelRecording));
  exports.Set("onRecordingEvent", Napi::Function::New(env, OnRecordingEvent));
  exports.Set("startCameraPreview", Napi::Function::New(env, StartCameraPreview));
  exports.Set("stopCameraPreview", Napi::Function::New(env, StopCameraPreview));
  return exports;
}

NODE_API_MODULE(mac_addon, Init)
