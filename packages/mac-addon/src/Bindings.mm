#include <napi.h>

#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

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
  }

  return options;
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
  result.Set("screenCaptureKit", IsMacOSAtLeast(13));
  result.Set("systemAudio", IsMacOSAtLeast(13));
  result.Set("screenCaptureKitMicrophone", IsMacOSAtLeast(15));
  result.Set("microphoneFallback", true);
  result.Set("camera", true);
  result.Set("separateFiles", true);
  result.Set("scRecordingOutput", IsMacOSAtLeast(15));
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
