#pragma once

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

// Owns the system-audio path. Rides on the same SCStream as the screen track,
// so this class is mostly a writer wrapper plus the SCStreamOutput delegate
// for audio frames.
@interface SystemAudioTrack : NSObject <SCStreamOutput>
- (instancetype)initWithOptions:(const RecordingOptions &)options;

- (BOOL)isEnabled;

- (void)setOutputURL:(NSURL *)url;
- (void)prepareWriter;

// Apply system-audio settings (capturesAudio, sampleRate, channelCount,
// excludesCurrentProcessAudio) to the SCStream configuration. No-op when
// disabled or running on macOS < 13.
- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration;

// Add audio output to the stream so audio frames are routed here.
- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error;

- (void)markStopping;

- (BOOL)finishWriterSync:(NSError **)error;
- (void)cancelWriter;
- (NSDictionary *)writerMetadata;
- (NSURL *)url;
- (BOOL)hasWriter;
@end
