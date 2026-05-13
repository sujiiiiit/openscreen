#pragma once

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

@class ScreenTrack;

// System-audio track. SCStream delivers system audio as
// SCStreamOutputTypeAudio sample buffers; this class forwards each one into
// the ScreenTrack's shared AVAssetWriter system-audio input.
@interface SystemAudioTrack : NSObject <SCStreamOutput>
- (instancetype)initWithOptions:(const RecordingOptions &)options
                    screenTrack:(ScreenTrack *)screenTrack;

- (BOOL)isEnabled;

// Apply system-audio settings (capturesAudio, sampleRate, channelCount,
// excludesCurrentProcessAudio) to the shared SCStream configuration.
- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration;

// Attach the SCStreamOutput so audio frames reach -stream:didOutputSampleBuffer:.
- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error;

- (void)markStopping;
- (NSDictionary *)metadata;
@end
