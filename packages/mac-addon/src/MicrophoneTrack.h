#pragma once

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

@class ScreenTrack;

// Microphone track. macOS 15+ delivers the mic over the shared SCStream as
// SCStreamOutputTypeMicrophone; this class forwards each sample into the
// ScreenTrack's shared AVAssetWriter microphone input.
@interface MicrophoneTrack : NSObject <SCStreamOutput>
- (instancetype)initWithOptions:(const RecordingOptions &)options
                    screenTrack:(ScreenTrack *)screenTrack;

- (BOOL)isEnabled;

// Apply microphone settings (captureMicrophone, microphoneCaptureDeviceID) to
// the shared SCStream configuration.
- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration;

// Attach the SCStreamOutput so mic frames reach -stream:didOutputSampleBuffer:.
- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error;

- (void)markStopping;
- (NSDictionary *)metadata;
@end
