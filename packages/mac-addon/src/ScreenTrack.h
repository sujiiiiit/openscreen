#pragma once

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

// Owns the screen-capture path: writer, queue, shareable-content lookup,
// content-filter and base SCStreamConfiguration build, and the SCStreamOutput
// delegate for screen frames.
@interface ScreenTrack : NSObject <SCStreamOutput>
- (instancetype)initWithOptions:(const RecordingOptions &)options;

// Configure output destination and instantiate the writer.
- (void)setOutputURL:(NSURL *)url;
- (void)prepareWriter;

// Shareable content + filter.
- (BOOL)getShareableContent:(SCShareableContent **)content error:(NSError **)error;
- (SCContentFilter *)contentFilterFromContent:(SCShareableContent *)content
                                        error:(NSError **)error;

// Returns an SCStreamConfiguration populated with screen-only settings
// (dimensions, fps, cursor, pixel format). Audio/microphone settings are
// applied by SystemAudioTrack / MicrophoneTrack.
- (SCStreamConfiguration *)streamConfigurationForContent:(SCShareableContent *)content;

// Add screen output to the stream so frames are routed to this track.
- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error;

// Stop flag — when set, sample-buffer delegate calls become no-ops.
- (void)markStopping;

// Writer lifecycle.
- (BOOL)finishWriterSync:(NSError **)error;
- (void)cancelWriter;
- (NSDictionary *)writerMetadata;
- (NSURL *)url;
- (BOOL)hasWriter;
@end
