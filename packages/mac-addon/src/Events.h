#pragma once

#include <napi.h>

#include <string>

struct EventPayload {
  std::string type;
  std::string sessionId;
  std::string source;
  std::string message;
  double durationMs = 0;
};

void EmitEvent(const EventPayload &payload);

// Installs (or replaces) the JS callback that receives EmitEvent payloads.
// Returns an "unsubscribe" function the caller may surface to JS.
Napi::Function InstallEventCallback(Napi::Env env, Napi::Function callback);
