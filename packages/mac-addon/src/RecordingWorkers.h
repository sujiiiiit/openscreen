#pragma once

#include <napi.h>

#include <string>
#include <vector>

#include "Common.h"

class StartRecordingWorker final : public Napi::AsyncWorker {
 public:
  StartRecordingWorker(Napi::Env env, const std::string &sessionId);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::string sessionId_;
  bool failed_ = false;
  std::string errorMessage_;
};

class StopRecordingWorker final : public Napi::AsyncWorker {
 public:
  StopRecordingWorker(Napi::Env env, const std::string &sessionId);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::string sessionId_;
};

class CancelRecordingWorker final : public Napi::AsyncWorker {
 public:
  CancelRecordingWorker(Napi::Env env, const std::string &sessionId);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::string sessionId_;
};

class ListShareableContentWorker final : public Napi::AsyncWorker {
 public:
  explicit ListShareableContentWorker(Napi::Env env);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<DisplayInfo> displays_;
  std::vector<WindowInfo> windows_;
  std::vector<AppInfo> apps_;
};
