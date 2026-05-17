#include "Events.h"

#include <memory>
#include <mutex>

static std::mutex gEventMutex;
static std::unique_ptr<Napi::ThreadSafeFunction> gEventCallback;

void EmitEvent(const EventPayload &payload) {
  std::lock_guard<std::mutex> lock(gEventMutex);
  if (!gEventCallback) {
    return;
  }

  auto *data = new EventPayload(payload);
  napi_status status = gEventCallback->NonBlockingCall(
      data, [](Napi::Env env, Napi::Function callback, EventPayload *event) {
        Napi::Object object = Napi::Object::New(env);
        object.Set("type", event->type);
        object.Set("sessionId", event->sessionId);
        if (!event->source.empty()) {
          object.Set("source", event->source);
        }
        if (!event->message.empty()) {
          object.Set("message", event->message);
        }
        if (event->durationMs > 0) {
          object.Set("durationMs", event->durationMs);
        }
        callback.Call({object});
        if (env.IsExceptionPending()) {
          env.GetAndClearPendingException();
        }
        delete event;
      });

  if (status != napi_ok) {
    delete data;
  }
}

Napi::Function InstallEventCallback(Napi::Env env, Napi::Function callback) {
  std::lock_guard<std::mutex> lock(gEventMutex);
  if (gEventCallback) {
    gEventCallback->Release();
    gEventCallback.reset();
  }

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env,
      callback,
      "OpenScreenRecordingEvent",
      256,
      1);
  gEventCallback = std::make_unique<Napi::ThreadSafeFunction>(tsfn);

  return Napi::Function::New(env, [](const Napi::CallbackInfo &callbackInfo) {
    std::lock_guard<std::mutex> unsubscribeLock(gEventMutex);
    if (gEventCallback) {
      gEventCallback->Release();
      gEventCallback.reset();
    }
    return callbackInfo.Env().Undefined();
  });
}
