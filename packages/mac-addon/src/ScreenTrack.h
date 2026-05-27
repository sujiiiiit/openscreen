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

// The container's file extension after option coercion ("mov" or "mp4"). Used
// by RecorderSession to assemble the screen file name. Resolved during
// -initWithOptions:sessionId: so it's safe to call before
// -streamConfigurationForContent:.
- (NSString *)fileExtension;

// SCKit setup.
//
// `getShareableContent:` is the legacy single-arg variant: always fresh, used
// where staleness would change semantics. The `wasFromCache:` variant lets
// `startSync` know whether the result came from the process-wide cache below
// so it can retry once on a "not found" lookup after invalidating.
- (BOOL)getShareableContent:(SCShareableContent **)content error:(NSError **)error;
- (BOOL)getShareableContent:(SCShareableContent **)content
                wasFromCache:(BOOL *)wasFromCache
                       error:(NSError **)error;
- (SCContentFilter *)contentFilterFromContent:(SCShareableContent *)content
                                        error:(NSError **)error;

// Process-wide cache for the recording-path query (onScreenWindowsOnly:NO,
// excludingDesktopWindows:NO). `SCShareableContent` is slow (~500ms–1s on
// each cold call); prewarming when the recorder bar / picker opens lets the
// click-to-recording-live path skip that wait. The cache has a short TTL
// (see implementation) and is invalidated on a not-found lookup so a stale
// snapshot never silently misses a freshly-opened window.
+ (void)prewarmShareableContent;
+ (void)invalidateShareableContentCache;

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

// Host-clock time (ms, CMClockGetHostTimeClock domain) of the first written
// video frame — i.e. the moment that maps to source time 0 in the .mov. The
// input track anchors its cursor timeline to this so cursor and video share an
// origin (ScreenCaptureKit delivers the first frame ~100–200 ms after the
// stream starts, so hostStartMs would lag the video by that much). Returns 0
// before the first frame is written.
- (double)sessionStartHostMs;
@end
