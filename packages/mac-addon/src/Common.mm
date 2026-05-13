#include "Common.h"

#import <AppKit/AppKit.h>

#include <cmath>
#include <cstring>

NSString *ToNSString(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()];
}

std::string ToStdString(NSString *value) {
  return value == nil ? std::string() : std::string([value UTF8String]);
}

bool IsMacOSAtLeast(NSInteger major) {
  NSOperatingSystemVersion version =
      [[NSProcessInfo processInfo] operatingSystemVersion];
  return version.majorVersion >= major;
}

std::string NewSessionId() {
  return ToStdString([[NSUUID UUID] UUIDString]);
}

std::string PermissionStateString(AVAuthorizationStatus status) {
  switch (status) {
    case AVAuthorizationStatusAuthorized:
      return "granted";
    case AVAuthorizationStatusDenied:
      return "denied";
    case AVAuthorizationStatusRestricted:
      return "restricted";
    case AVAuthorizationStatusNotDetermined:
    default:
      return "notDetermined";
  }
}

double TimeToMilliseconds(CMTime time) {
  if (!CMTIME_IS_VALID(time) || CMTIME_IS_INDEFINITE(time)) {
    return 0;
  }
  Float64 seconds = CMTimeGetSeconds(time);
  if (!std::isfinite(seconds)) {
    return 0;
  }
  return seconds * 1000.0;
}

NSString *OSErrorDomain() {
  return @"OpenScreenRecorder";
}

NSError *MakeError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:OSErrorDomain()
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

std::string GetStringProp(Napi::Object object,
                          const char *name,
                          const std::string &fallback) {
  Napi::Value value = object.Get(name);
  return value.IsString() ? value.As<Napi::String>().Utf8Value() : fallback;
}

bool GetBoolProp(Napi::Object object, const char *name, bool fallback) {
  Napi::Value value = object.Get(name);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

int GetIntProp(Napi::Object object, const char *name, int fallback) {
  Napi::Value value = object.Get(name);
  return value.IsNumber() ? value.As<Napi::Number>().Int32Value() : fallback;
}

uint32_t GetUint32Prop(Napi::Object object,
                       const char *name,
                       uint32_t fallback) {
  Napi::Value value = object.Get(name);
  return value.IsNumber() ? value.As<Napi::Number>().Uint32Value() : fallback;
}

Napi::Value NSObjectToNapi(Napi::Env env, id value) {
  if (!value || value == [NSNull null]) {
    return env.Null();
  }
  if ([value isKindOfClass:[NSString class]]) {
    return Napi::String::New(env, ToStdString((NSString *)value));
  }
  if ([value isKindOfClass:[NSNumber class]]) {
    const char *type = [(NSNumber *)value objCType];
    if (strcmp(type, @encode(BOOL)) == 0) {
      return Napi::Boolean::New(env, [(NSNumber *)value boolValue]);
    }
    return Napi::Number::New(env, [(NSNumber *)value doubleValue]);
  }
  if ([value isKindOfClass:[NSDictionary class]]) {
    return NSDictionaryToNapi(env, (NSDictionary *)value);
  }
  if ([value isKindOfClass:[NSArray class]]) {
    NSArray *array = (NSArray *)value;
    Napi::Array result = Napi::Array::New(env, array.count);
    for (NSUInteger i = 0; i < array.count; ++i) {
      result.Set((uint32_t)i, NSObjectToNapi(env, array[i]));
    }
    return result;
  }
  return Napi::String::New(env, ToStdString([value description]));
}

Napi::Object NSDictionaryToNapi(Napi::Env env, NSDictionary *dictionary) {
  Napi::Object object = Napi::Object::New(env);
  for (id key in dictionary) {
    object.Set(ToStdString([key description]), NSObjectToNapi(env, dictionary[key]));
  }
  return object;
}
