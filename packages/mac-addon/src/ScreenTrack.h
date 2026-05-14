#pragma once

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "Common.h"

// Owns the screen-capture path AND the muxed AVAssetWriter that produces the
// final .mov. The writer holds up to three AVAssetWriterInputs:
//
//   * video        — HEVC Main10 (Apple Silicon) / H.264 (Intel), tagged
//                    with explicit P3-D65 primaries, Rec.709 transfer, and
//                    Rec.709 YCbCr matrix so any colour-managed player
//                    renders the full Display-P3 gamut correctly.
//   * systemAudio  — AAC, populated lazily once the first sample's format
//                    description is known.
//   * microphone   — AAC, ditto.
//
// SystemAudioTrack and MicrophoneTrack receive their own SCStreamOutput
// callbacks and forward sample buffers into this writer via the
// -appendSystemAudioSampleBuffer: / -appendMicrophoneSampleBuffer: methods.
@interface ScreenTrack : NSObject <SCStreamOutput>
- (instancetype)initWithOptions:(const RecordingOptions &)options
                       sessionId:(NSString *)sessionId;

// Output destination.
- (void)setOutputURL:(NSURL *)url;

// SCKit setup.
- (BOOL)getShareableContent:(SCShareableContent **)content error:(NSError **)error;
- (SCContentFilter *)contentFilterFromContent:(SCShareableContent *)content
                                        error:(NSError **)error;

// Builds the SCStreamConfiguration with 10-bit packed RGB pixels in Display
// P3, recording-tuned queue depth, and an SDR dynamic range cap.
- (SCStreamConfiguration *)streamConfigurationForContent:(SCShareableContent *)content;

// Instantiate AVAssetWriter and the video input now that dimensions are
// known. Must be called after -streamConfigurationForContent: and before
// -addSystemAudioInput: / -addMicrophoneInput: / -addToStream:.
- (BOOL)prepareWriter:(NSError **)error;

// Add the system-audio / microphone inputs to the shared writer. The input
// settings are fixed (AAC, 48 kHz, stereo) — no need to wait for a sample
// format description. Returns NO and populates *error if the writer cannot
// accept another input.
- (BOOL)addSystemAudioInput:(NSError **)error;
- (BOOL)addMicrophoneInput:(NSError **)error;

// Returns YES if the writer has a system-audio / microphone input attached
// (i.e. the corresponding -addXxxInput: succeeded).
- (BOOL)hasSystemAudioInput;
- (BOOL)hasMicrophoneInput;

// Attach the SCStreamOutput for screen frames.
- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error;

// Forward audio sample buffers from SystemAudioTrack / MicrophoneTrack.
- (void)appendSystemAudioSampleBuffer:(CMSampleBufferRef)sampleBuffer;
- (void)appendMicrophoneSampleBuffer:(CMSampleBufferRef)sampleBuffer;

// Lifecycle.
- (void)markStopping;
- (BOOL)finishWriterSync:(NSError **)error;
- (void)cancelWriter;

// Pause / resume. Samples are dropped while paused; on resume, the host-clock
// pause duration is accumulated and subtracted from every subsequent sample
// PTS so the writer sees a continuous timeline with no gap.
- (void)setPaused:(BOOL)paused;
- (BOOL)isPaused;
- (CMTime)pauseAccumulated;

// Manifest.
- (NSDictionary *)metadata;
- (NSURL *)url;
- (BOOL)hasWriter;
- (BOOL)hasStarted;
@end
