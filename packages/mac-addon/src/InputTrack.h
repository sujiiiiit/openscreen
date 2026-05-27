#pragma once

#import <Foundation/Foundation.h>

#include "Common.h"

// Records mouse moves/drags/clicks (and, when enabled + permitted, keystrokes)
// plus cursor-shape changes into Screen Studio-shaped sidecar JSON files next
// to the screen video:
//
//   mousemoves-0.json   {activeModifiers, cursorId, processTimeMs, type, unixTimeMs, x, y (+button on drags)}
//   mouseclicks-0.json  {…, button, type:"mouseDown"|"mouseUp"}
//   keystrokes-0.json    {activeModifiers, character, isARepeat, processTimeMs, type, unixTimeMs}
//   cursors.json + cursors/<id>.png   (when captureCursorShapes)
//
// Events are stamped on the same dual clock the rest of the session uses:
// processTimeMs == NSEvent.timestamp (seconds-since-boot × 1000, the
// CMClockGetHostTimeClock domain) and unixTimeMs == processTimeMs + offset,
// where offset = startedAtUnixMs − hostStartMs.
//
// THREADING: the NSEvent monitor handler and the cursor sampler both run on the
// main thread; file writes are dispatched to a private serial queue. start /
// finish marshal their AppKit work to the main thread, so they are safe to call
// from a background worker.
@interface InputTrack : NSObject

- (instancetype)initWithOptions:(const RecordingOptions &)options;

// YES when options.captureInput is set (directly or implied).
- (BOOL)isEnabled;

// Destination for the sidecar files. Call before -startWithHostStartMs:.
- (void)setOutputDirectory:(NSURL *)directory;

// Begin capture. hostStartMs / startedAtUnixMs come from RecorderSession's
// shared clock (manifest hostStartMs / startedAtUnixMs).
- (BOOL)startWithHostStartMs:(double)hostStartMs
              startedAtUnixMs:(double)startedAtUnixMs
                        error:(NSError **)error;

// Anchor the cursor timeline's origin to the screen video's first-frame host
// time (ScreenTrack -sessionStartHostMs) instead of the stream-start hostStartMs,
// so the recorded cursor and the video share source time 0. Call before -finish
// (i.e. before the manifest is written). 0 keeps the hostStartMs default.
- (void)setVideoStartHostMs:(double)hostMs;

// Drop events while paused / stopping.
- (void)setPaused:(BOOL)paused;
- (void)markStopping;

// Remove the monitor, stop the sampler, flush + close the files, and write
// cursors.json. Idempotent.
- (void)finish;

// Manifest contributions.
- (NSDictionary *)metadata;        // the "input" session block
- (NSDictionary *)filesDictionary; // absolute paths keyed by source

@end
