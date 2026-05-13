#pragma once

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

// Owns the microphone path with two delivery modes:
//   1. ScreenCaptureKit microphone capture (macOS 15+), where audio frames
//      arrive on the shared SCStream as SCStreamOutputTypeMicrophone.
//   2. AVFoundation fallback, where a dedicated AVCaptureSession produces
//      audio sample buffers.
// The source is decided when -configureSCStreamConfig: is called and is
// reflected by -usesScreenCaptureKit afterwards.
@interface MicrophoneTrack : NSObject <SCStreamOutput,
                                       AVCaptureAudioDataOutputSampleBufferDelegate>
- (instancetype)initWithOptions:(const RecordingOptions &)options;

- (BOOL)isEnabled;
- (BOOL)usesScreenCaptureKit;

- (void)setOutputURL:(NSURL *)url;
- (void)prepareWriter;

// On macOS 15+, this opts the SCStream into microphone capture and sets the
// "uses SCKit" flag. On earlier systems (or when the mic is disabled), this
// is a no-op and the track falls back to AVFoundation in -setupFallbackIfNeeded:.
- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration;

// Create the AVCaptureSession + output when the mic is enabled but SCKit
// capture is not in use. No-op otherwise.
- (BOOL)setupFallbackIfNeeded:(NSError **)error;

// Start / stop the fallback AVCaptureSession (no-op when SCKit path is in use).
- (void)startFallback;
- (void)stopFallback;
- (void)resetFallback;

// Add SCKit microphone output to the stream. No-op when AVF fallback is in use.
- (BOOL)addSCKitOutputToStream:(SCStream *)stream error:(NSError **)error;

- (void)markStopping;

// True when the given AVCaptureOutput is this track's fallback output.
- (BOOL)ownsCaptureOutput:(AVCaptureOutput *)output;

- (BOOL)finishWriterSync:(NSError **)error;
- (void)cancelWriter;
- (NSDictionary *)writerMetadata;
- (NSURL *)url;
- (BOOL)hasWriter;
@end
