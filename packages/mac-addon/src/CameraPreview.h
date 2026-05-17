#pragma once

#include <napi.h>

#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

#include <cstdint>
#include <string>

@class RecorderSession;

// Standalone preview session (no recording in progress) — drives the camera
// hardware directly and pushes BGRA->RGBA frames to a JS callback.
@interface OSCameraPreviewSession : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
- (instancetype)initWithDeviceId:(NSString *)deviceId;
- (BOOL)startWithError:(NSError **)error;
- (void)stop;
@end

// Recorder <-> preview coordination. The active recorder pointer lets a
// startCameraPreview call adopt an in-progress recording's camera session
// when the device IDs match (so we don't open the camera twice).
void SetActiveRecorder(RecorderSession *recorder);
void ClearActiveRecorder(RecorderSession *recorder);
RecorderSession *ActiveRecorderForPreview();

// Each start/stop request gets a generation number; workers use it to drop
// stale requests when a newer one has superseded them.
uint64_t NextPreviewGeneration();
BOOL IsCurrentPreviewGeneration(uint64_t generation);

// Deliver a single RGBA frame to the JS callback. No-op if no callback is
// installed. Called by CameraTrack's preview output and by OSCameraPreviewSession.
void DeliverPreviewFrame(CVPixelBufferRef pixelBuffer);

// Tear down whatever preview state is in place (standalone session, hosted
// preview on a recorder, JS callback, frame pool).
void StopCameraPreviewInternal();

// Recorder lifecycle hooks. Called from RecorderSession's start/stop to
// adopt an in-flight standalone preview and to hand it back when recording
// ends.
void AdoptPendingPreviewForRecorder(RecorderSession *recorder);
void ReleasePreviewForRecorderOnStop(RecorderSession *recorder);

// Worker classes.
class StartCameraPreviewWorker final : public Napi::AsyncWorker {
 public:
  StartCameraPreviewWorker(Napi::Env env,
                           std::string deviceId,
                           Napi::ThreadSafeFunction tsfn,
                           uint64_t generation);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::string deviceId_;
  Napi::ThreadSafeFunction tsfn_;
  uint64_t generation_;
  bool failed_ = false;
  bool published_ = false;
  std::string errorMessage_;
};

class StopCameraPreviewWorker final : public Napi::AsyncWorker {
 public:
  StopCameraPreviewWorker(Napi::Env env, uint64_t generation);

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override;
  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uint64_t generation_;
};
