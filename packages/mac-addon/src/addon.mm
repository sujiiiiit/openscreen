#include <napi.h>
#import <Foundation/Foundation.h>

static Napi::String Hello(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSString* greeting = @"Hello, World from macOS native addon!";
  return Napi::String::New(env, [greeting UTF8String]);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "hello"),
              Napi::Function::New(env, Hello));
  return exports;
}

NODE_API_MODULE(mac_addon, Init)
