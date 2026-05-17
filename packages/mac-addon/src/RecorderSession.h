#pragma once

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

// Coordinator that owns the four per-track helpers (screen, camera, system
// audio, microphone) and the shared SCStream. Implements SCStreamDelegate for
// stream-level error callbacks; the per-track SCStreamOutput delegates live
// on the track helpers themselves.
@interface RecorderSession : NSObject <SCStreamDelegate>
- (instancetype)initWithOptions:(const RecordingOptions &)options;
- (BOOL)startSync:(NSError **)error;
- (BOOL)stopSync:(NSError **)error;
- (void)cancelSync;
- (BOOL)pauseSync:(NSError **)error;
- (BOOL)resumeSync:(NSError **)error;
- (BOOL)isPaused;
// Total paused duration in milliseconds since the session started. Reflects
// in-flight pauses, so the UI timer can keep ticking off this value.
- (double)pausedMs;
- (NSDictionary *)startResult;
- (NSDictionary *)stopResult;
- (NSString *)sessionId;
- (NSString *)cameraDeviceId;
- (BOOL)attachPreviewOutput:(NSError **)error;
- (void)detachPreviewOutput;
@end

// Session store — JS gives us session IDs, workers look up the session here.
void StoreSession(RecorderSession *session);
RecorderSession *GetSession(const std::string &sessionId);
void RemoveSession(const std::string &sessionId);
