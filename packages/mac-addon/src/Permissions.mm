#include "Permissions.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/hidsystem/IOHIDLib.h>

#include <atomic>

// macOS does not expose denied/restricted distinctly for screen capture —
// CGPreflightScreenCaptureAccess returns a plain bool. Track whether we've
// already prompted via CGRequestScreenCaptureAccess: a `false` preflight
// before any prompt is "notDetermined", a `false` preflight after a prompt
// is "denied". The flag is process-scoped, which matches the TCC model.
static std::atomic<bool> gScreenCaptureRequested(false);

static std::string ScreenCapturePermissionString() {
  if (CGPreflightScreenCaptureAccess()) return "granted";
  return gScreenCaptureRequested.load(std::memory_order_acquire)
      ? "denied"
      : "notDetermined";
}

// Input Monitoring (TCC ListenEvent) — required to capture global keystrokes.
// IOHIDCheckAccess distinguishes notDetermined / denied / granted, mapping
// cleanly onto our PermissionState vocabulary.
static std::string InputMonitoringPermissionString() {
  if (@available(macOS 10.15, *)) {
    switch (IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)) {
      case kIOHIDAccessTypeGranted: return "granted";
      case kIOHIDAccessTypeDenied: return "denied";
      case kIOHIDAccessTypeUnknown:
      default: return "notDetermined";
    }
  }
  return "granted";
}

Napi::Object GetPermissionsObject(Napi::Env env) {
  Napi::Object permissions = Napi::Object::New(env);
  std::string screenState = ScreenCapturePermissionString();
  permissions.Set("screen", screenState);
  permissions.Set("systemAudio", screenState);
  permissions.Set("camera",
                  PermissionStateString(
                      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]));
  permissions.Set("microphone",
                  PermissionStateString(
                      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]));
  permissions.Set("inputMonitoring", InputMonitoringPermissionString());
  return permissions;
}

static void RequestAVAccess(AVMediaType mediaType) {
  if ([AVCaptureDevice authorizationStatusForMediaType:mediaType] !=
      AVAuthorizationStatusNotDetermined) {
    return;
  }

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [AVCaptureDevice requestAccessForMediaType:mediaType
                           completionHandler:^(__unused BOOL granted) {
    dispatch_semaphore_signal(semaphore);
  }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
}

RequestPermissionsWorker::RequestPermissionsWorker(
    Napi::Env env, std::vector<std::string> kinds)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      kinds_(std::move(kinds)) {}

void RequestPermissionsWorker::Execute() {
  @autoreleasepool {
    for (const std::string &kind : kinds_) {
      if (kind == "screen" || kind == "systemAudio") {
        CGRequestScreenCaptureAccess();
        gScreenCaptureRequested.store(true, std::memory_order_release);
      } else if (kind == "camera") {
        RequestAVAccess(AVMediaTypeVideo);
      } else if (kind == "microphone") {
        RequestAVAccess(AVMediaTypeAudio);
      } else if (kind == "inputMonitoring") {
        if (@available(macOS 10.15, *)) {
          // Prompts on first call when notDetermined; no-op once decided. The
          // updated state is read back via GetPermissionsObject in OnOK.
          IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
        }
      }
    }
  }
}

void RequestPermissionsWorker::OnOK() {
  deferred_.Resolve(GetPermissionsObject(Env()));
}
