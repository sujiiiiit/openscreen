#pragma once

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include "Common.h"

// Owns the camera capture path: AVCaptureSession, camera writer, and the
// optional live-preview tap (a second VideoDataOutput that delivers frames
// to the camera preview module while recording).
@interface CameraTrack : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
- (instancetype)initWithOptions:(const RecordingOptions &)options;

- (BOOL)isEnabled;
- (NSString *)deviceId;

- (void)setOutputURL:(NSURL *)url;
- (void)prepareWriter;

- (BOOL)setupAVCaptureSession:(NSError **)error;
- (void)startCapture;
- (void)stopCapture;
- (void)resetCapture;

- (BOOL)hasCaptureSession;

// Live-preview tap. attachPreviewOutput adds a second VideoDataOutput to the
// camera session; detachPreviewOutput removes it. Both are no-ops if no
// session is configured / the output is already in the desired state.
- (BOOL)attachPreviewOutput:(NSError **)error;
- (void)detachPreviewOutput;

- (void)markStopping;

- (BOOL)finishWriterSync:(NSError **)error;
- (void)cancelWriter;
- (NSDictionary *)writerMetadata;
- (NSURL *)url;
- (BOOL)hasWriter;
@end
