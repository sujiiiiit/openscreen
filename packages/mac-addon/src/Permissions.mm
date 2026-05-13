#include "Permissions.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>

Napi::Object GetPermissionsObject(Napi::Env env) {
  Napi::Object permissions = Napi::Object::New(env);
  bool screenGranted = CGPreflightScreenCaptureAccess();
  permissions.Set("screen", screenGranted ? "granted" : "notDetermined");
  permissions.Set("systemAudio", screenGranted ? "granted" : "notDetermined");
  permissions.Set("camera",
                  PermissionStateString(
                      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]));
  permissions.Set("microphone",
                  PermissionStateString(
                      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]));
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
      } else if (kind == "camera") {
        RequestAVAccess(AVMediaTypeVideo);
      } else if (kind == "microphone") {
        RequestAVAccess(AVMediaTypeAudio);
      }
    }
  }
}

void RequestPermissionsWorker::OnOK() {
  deferred_.Resolve(GetPermissionsObject(Env()));
}
