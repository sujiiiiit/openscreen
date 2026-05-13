#pragma once

#include <napi.h>

#include <string>
#include <vector>

#include "Common.h"

Napi::Object GetPermissionsObject(Napi::Env env);

class RequestPermissionsWorker final : public Napi::AsyncWorker {
 public:
  RequestPermissionsWorker(Napi::Env env, std::vector<std::string> kinds);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<std::string> kinds_;
};
