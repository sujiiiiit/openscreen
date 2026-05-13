#include "RecordingWorkers.h"

#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "RecorderSession.h"

StartRecordingWorker::StartRecordingWorker(Napi::Env env, const std::string &sessionId)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      sessionId_(sessionId) {}

void StartRecordingWorker::Execute() {
  @autoreleasepool {
    RecorderSession *session = GetSession(sessionId_);
    if (!session) {
      failed_ = true;
      errorMessage_ = "Recording session was not found";
      return;
    }
    NSError *error = nil;
    if (![session startSync:&error]) {
      failed_ = true;
      errorMessage_ = ToStdString([error localizedDescription]);
    }
  }
}

void StartRecordingWorker::OnOK() {
  if (failed_) {
    RemoveSession(sessionId_);
    deferred_.Reject(Napi::Error::New(Env(), errorMessage_).Value());
    return;
  }
  RecorderSession *session = GetSession(sessionId_);
  if (!session) {
    deferred_.Reject(Napi::Error::New(Env(), "Recording session was not found").Value());
    return;
  }
  deferred_.Resolve(NSDictionaryToNapi(Env(), [session startResult]));
}

StopRecordingWorker::StopRecordingWorker(Napi::Env env, const std::string &sessionId)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      sessionId_(sessionId) {}

void StopRecordingWorker::Execute() {
  @autoreleasepool {
    RecorderSession *session = GetSession(sessionId_);
    if (!session) {
      SetError("Recording session was not found");
      return;
    }
    NSError *error = nil;
    if (![session stopSync:&error]) {
      SetError(ToStdString([error localizedDescription]));
    }
  }
}

void StopRecordingWorker::OnOK() {
  RecorderSession *session = GetSession(sessionId_);
  if (!session) {
    deferred_.Reject(Napi::Error::New(Env(), "Recording session was not found").Value());
    return;
  }
  NSDictionary *result = [session stopResult];
  RemoveSession(sessionId_);
  deferred_.Resolve(NSDictionaryToNapi(Env(), result));
}

CancelRecordingWorker::CancelRecordingWorker(Napi::Env env, const std::string &sessionId)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      sessionId_(sessionId) {}

void CancelRecordingWorker::Execute() {
  @autoreleasepool {
    RecorderSession *session = GetSession(sessionId_);
    if (!session) {
      return;
    }
    [session cancelSync];
    RemoveSession(sessionId_);
  }
}

ListShareableContentWorker::ListShareableContentWorker(Napi::Env env)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)) {}

void ListShareableContentWorker::Execute() {
  @autoreleasepool {
    __block NSError *error = nil;
    __block SCShareableContent *content = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                               onScreenWindowsOnly:YES
                                                 completionHandler:^(SCShareableContent *shareableContent,
                                                                     NSError *shareableError) {
      content = shareableContent;
      error = shareableError;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

    if (!content || error) {
      SetError(ToStdString([error localizedDescription]));
      return;
    }

    for (SCDisplay *display in content.displays) {
      DisplayInfo info;
      info.id = display.displayID;
      info.width = display.width;
      info.height = display.height;
      info.x = display.frame.origin.x;
      info.y = display.frame.origin.y;
      displays_.push_back(info);
    }

    for (SCWindow *window in content.windows) {
      WindowInfo info;
      info.id = window.windowID;
      info.title = ToStdString(window.title);
      info.onScreen = window.isOnScreen;
      info.x = window.frame.origin.x;
      info.y = window.frame.origin.y;
      info.width = window.frame.size.width;
      info.height = window.frame.size.height;
      if (window.owningApplication) {
        info.appName = ToStdString(window.owningApplication.applicationName);
        info.bundleId = ToStdString(window.owningApplication.bundleIdentifier);
        info.pid = window.owningApplication.processID;
      }
      windows_.push_back(info);
    }

    for (SCRunningApplication *app in content.applications) {
      AppInfo info;
      info.name = ToStdString(app.applicationName);
      info.bundleId = ToStdString(app.bundleIdentifier);
      info.pid = app.processID;
      apps_.push_back(info);
    }
  }
}

void ListShareableContentWorker::OnOK() {
  Napi::Env env = Env();
  Napi::Object result = Napi::Object::New(env);

  Napi::Array displays = Napi::Array::New(env, displays_.size());
  for (size_t i = 0; i < displays_.size(); ++i) {
    Napi::Object item = Napi::Object::New(env);
    item.Set("displayId", displays_[i].id);
    item.Set("width", (double)displays_[i].width);
    item.Set("height", (double)displays_[i].height);
    item.Set("x", displays_[i].x);
    item.Set("y", displays_[i].y);
    displays.Set((uint32_t)i, item);
  }

  Napi::Array windows = Napi::Array::New(env, windows_.size());
  for (size_t i = 0; i < windows_.size(); ++i) {
    Napi::Object item = Napi::Object::New(env);
    item.Set("windowId", windows_[i].id);
    item.Set("title", windows_[i].title);
    item.Set("applicationName", windows_[i].appName);
    item.Set("bundleId", windows_[i].bundleId);
    item.Set("processId", windows_[i].pid);
    item.Set("onScreen", windows_[i].onScreen);
    item.Set("x", windows_[i].x);
    item.Set("y", windows_[i].y);
    item.Set("width", windows_[i].width);
    item.Set("height", windows_[i].height);
    windows.Set((uint32_t)i, item);
  }

  Napi::Array apps = Napi::Array::New(env, apps_.size());
  for (size_t i = 0; i < apps_.size(); ++i) {
    Napi::Object item = Napi::Object::New(env);
    item.Set("applicationName", apps_[i].name);
    item.Set("bundleId", apps_[i].bundleId);
    item.Set("processId", apps_[i].pid);
    apps.Set((uint32_t)i, item);
  }

  result.Set("displays", displays);
  result.Set("windows", windows);
  result.Set("applications", apps);
  deferred_.Resolve(result);
}
