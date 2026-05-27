#pragma once

#include <napi.h>

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>

#include <cstdint>
#include <string>
#include <vector>

struct CaptureTarget {
  std::string type = "display";
  uint32_t displayId = 0;
  uint32_t windowId = 0;
  std::string bundleId;
  std::string title;
  std::string applicationName;
  int processId = 0;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  double sourceX = 0;
  double sourceY = 0;
  double sourceWidth = 0;
  double sourceHeight = 0;
  double scaleFactor = 0;
};

struct RecordingOptions {
  std::string sessionId;
  std::string outputDir;
  std::string basename;
  CaptureTarget target;
  int fps = 60;
  int width = 0;
  int height = 0;
  bool includeCursor = true;
  bool recordSystemAudio = true;
  bool recordMicrophone = false;
  bool recordCamera = false;
  bool excludeOwnApp = true;
  std::string microphoneDeviceId;
  std::string cameraDeviceId;
  // Bundle IDs of applications whose audio should be exclusively captured. Empty
  // means "no per-app audio filtering" (default: all system audio minus the
  // recorder app). Honored on macOS 15+ via SCStreamConfiguration.
  // applicationsToInclude; on 13-14 the surrounding SCContentFilter already
  // scopes audio to the owning app of a window target.
  std::vector<std::string> audioApplicationBundleIds;

  // ── Screen video quality settings ─────────────────────────────────────
  //
  // Every field below has a sensible default that preserves prior behavior
  // when omitted by the caller. The native side coerces invalid inputs
  // (unknown codec / container / quality) onto a working set in
  // ScreenTrack -resolveOptions.
  //
  // videoCodec:
  //   "" / unknown → "hevc" on Apple Silicon, "h264" on Intel.
  //   "hevc" → HEVC (H.265), VideoToolbox default profile.
  //   "h264" → H.264 (AVC), High AutoLevel by default.
  std::string videoCodec;
  // "low" | "medium" | "high" — bits-per-pixel multiplier for the encoder.
  std::string videoQuality = "high";
  // "mov" | "mp4". Both codecs work in both containers.
  std::string container = "mov";
  // "native" → logical points × pointPixelScale (Retina). "logical" → bare
  // logical-point dimensions. Both still snap to even pixel counts.
  std::string resolutionMode = "native";
  // 0 → "native" (1/120s minimum interval, follows display refresh up to 120).
  // 24 / 30 / 60 set explicit frame rates. If both `fps` and `frameRate` are
  // present, `frameRate` wins.
  int frameRate = -1;  // -1 sentinel: fall back to `fps`.

  // ── Input capture (Screen Studio-style sidecar metadata) ──────────────
  //
  // When `captureInput` is on, the session records mouse moves/drags/clicks
  // (and, when `captureKeyStrokes` is also on AND Input Monitoring is granted,
  // keystrokes) into streaming JSON sidecar files next to the screen video,
  // using the same field schema Screen Studio's `.screenstudio` bundles use.
  //
  // `captureCursorShapes` additionally builds an NSCursor catalog
  // (cursors.json + cursors/*.png) and resolves a semantic `cursorId` for
  // every event, synthesising a move when the cursor shape changes without
  // the pointer moving. None of these change the recorded video — they only
  // emit sidecar data. To let an editor restyle the cursor, the caller should
  // also set `includeCursor = false` so no cursor is baked into the frames.
  bool captureInput = false;
  bool captureKeyStrokes = false;
  bool captureCursorShapes = false;
};

struct DisplayInfo {
  uint32_t id = 0;
  int64_t width = 0;
  int64_t height = 0;
  double x = 0;
  double y = 0;
};

struct WindowInfo {
  uint32_t id = 0;
  std::string title;
  std::string appName;
  std::string bundleId;
  std::string iconDataUrl;
  int pid = 0;
  bool onScreen = false;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

struct AppInfo {
  std::string name;
  std::string bundleId;
  int pid = 0;
};

NSString *ToNSString(const std::string &value);
std::string ToStdString(NSString *value);
bool IsMacOSAtLeast(NSInteger major);
std::string NewSessionId();
std::string PermissionStateString(AVAuthorizationStatus status);
double TimeToMilliseconds(CMTime time);
NSString *OSErrorDomain();
NSError *MakeError(NSInteger code, NSString *message);

std::string GetStringProp(Napi::Object object,
                          const char *name,
                          const std::string &fallback = "");
bool GetBoolProp(Napi::Object object, const char *name, bool fallback = false);
int GetIntProp(Napi::Object object, const char *name, int fallback = 0);
double GetDoubleProp(Napi::Object object, const char *name, double fallback = 0);
uint32_t GetUint32Prop(Napi::Object object,
                       const char *name,
                       uint32_t fallback = 0);

Napi::Value NSObjectToNapi(Napi::Env env, id value);
Napi::Object NSDictionaryToNapi(Napi::Env env, NSDictionary *dictionary);
