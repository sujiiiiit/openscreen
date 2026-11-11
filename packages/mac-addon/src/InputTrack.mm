#include "InputTrack.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CGEvent.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <IOKit/hidsystem/IOHIDLib.h>

#include <atomic>
#include <os/lock.h>

#include "CursorTrack.h"

// Sidecar file names — Screen Studio uses a session index suffix; this session
// model accumulates pauses rather than splitting, so the index is always 0.
static NSString *const kMouseMovesFilename = @"mousemoves-0.json";
static NSString *const kMouseClicksFilename = @"mouseclicks-0.json";
static NSString *const kKeyStrokesFilename = @"keystrokes-0.json";
static NSString *const kTypingCaretFilename = @"typingcaret-0.json";
static NSString *const kCursorsInfoFile = @"cursors.json";
static NSString *const kCursorImagesFolder = @"cursors";

// Cursor sampler interval. 60 Hz mirrors Screen Studio's display-link cadence
// closely enough to catch shape changes promptly without burning the main
// thread. A synthesized move is only emitted when the shape changed and no real
// move carried it within this window.
static const NSTimeInterval kCursorSampleInterval = 1.0 / 60.0;
static const double kSynthesizedMoveGapMs = 30.0;

// Text-caret sampling (Accessibility). A keyDown schedules ONE caret read this
// long after the key so the focused app has processed it and moved its
// insertion point; further keys inside the window coalesce into that same read
// (≈25 Hz ceiling under fast typing). The AX messaging timeout bounds how long
// an unresponsive app can stall the (private, off-main) caret queue.
static const double kCaretQueryDelayMs = 40.0;
static const float kAXMessagingTimeoutSec = 0.05f;

// Current host clock in ms — same domain as NSEvent.timestamp × 1000.
static double HostNowMs() {
  return TimeToMilliseconds(CMClockGetTime(CMClockGetHostTimeClock()));
}

static NSArray<NSString *> *ModifierStrings(NSEventModifierFlags flags) {
  NSMutableArray<NSString *> *mods = [NSMutableArray array];
  if (flags & NSEventModifierFlagShift) [mods addObject:@"shift"];
  if (flags & NSEventModifierFlagControl) [mods addObject:@"control"];
  if (flags & NSEventModifierFlagOption) [mods addObject:@"option"];
  if (flags & NSEventModifierFlagCommand) [mods addObject:@"command"];
  if (flags & NSEventModifierFlagCapsLock) [mods addObject:@"capsLock"];
  if (flags & NSEventModifierFlagFunction) [mods addObject:@"function"];
  return mods;
}

static NSArray<NSString *> *CGModifierStrings(CGEventFlags flags) {
  NSMutableArray<NSString *> *mods = [NSMutableArray array];
  if (flags & kCGEventFlagMaskShift) [mods addObject:@"shift"];
  if (flags & kCGEventFlagMaskControl) [mods addObject:@"control"];
  if (flags & kCGEventFlagMaskAlternate) [mods addObject:@"option"];
  if (flags & kCGEventFlagMaskCommand) [mods addObject:@"command"];
  if (flags & kCGEventFlagMaskAlphaShift) [mods addObject:@"capsLock"];
  if (flags & kCGEventFlagMaskSecondaryFn) [mods addObject:@"function"];
  return mods;
}

#pragma mark - Accessibility caret lookup

// Bounds of `range` in the element's text, in global top-left points (the same
// space as CGEventGetLocation / CGDisplayBounds). Rejects the degenerate
// zero rects some apps return instead of an error.
static BOOL AXBoundsForRange(AXUIElementRef element, CFRange range, CGRect *out) {
  AXValueRef rangeArg = AXValueCreate((AXValueType)kAXValueTypeCFRange, &range);
  if (!rangeArg) return NO;
  CFTypeRef boundsValue = NULL;
  AXError err = AXUIElementCopyParameterizedAttributeValue(
      element, kAXBoundsForRangeParameterizedAttribute, rangeArg, &boundsValue);
  CFRelease(rangeArg);
  if (err != kAXErrorSuccess || !boundsValue) return NO;
  CGRect rect = CGRectZero;
  BOOL ok = CFGetTypeID(boundsValue) == AXValueGetTypeID() &&
            AXValueGetType((AXValueRef)boundsValue) == (AXValueType)kAXValueTypeCGRect &&
            AXValueGetValue((AXValueRef)boundsValue, (AXValueType)kAXValueTypeCGRect, &rect);
  CFRelease(boundsValue);
  if (!ok || rect.size.height <= 0 || (rect.origin.x == 0 && rect.origin.y == 0)) {
    return NO;
  }
  *out = rect;
  return YES;
}

// The focused element's frame (kAXPosition + kAXSize), global top-left points.
static BOOL AXElementFrame(AXUIElementRef element, CGRect *out) {
  CFTypeRef positionValue = NULL;
  CFTypeRef sizeValue = NULL;
  BOOL ok = NO;
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &positionValue) ==
          kAXErrorSuccess &&
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue) ==
          kAXErrorSuccess &&
      positionValue && sizeValue) {
    ok = AXValueGetValue((AXValueRef)positionValue, (AXValueType)kAXValueTypeCGPoint, &position) &&
         AXValueGetValue((AXValueRef)sizeValue, (AXValueType)kAXValueTypeCGSize, &size);
  }
  if (positionValue) CFRelease(positionValue);
  if (sizeValue) CFRelease(sizeValue);
  if (!ok || size.width <= 0 || size.height <= 0) return NO;
  *out = CGRectMake(position.x, position.y, size.width, size.height);
  return YES;
}

// Resolve the system-wide focused text insertion point. Prefers the exact caret
// (bounds of the selected range — or, for an empty range most apps can't
// measure, the trailing edge of the previous character); falls back to the
// focused element's frame so at least the field being typed in is known.
// `source` is "caret" or "element" so the editor can weigh the precision.
static BOOL CopyFocusedCaretRect(AXUIElementRef systemWide, CGRect *outRect,
                                 NSString **outSource) {
  CFTypeRef focusedValue = NULL;
  if (AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute,
                                    &focusedValue) != kAXErrorSuccess ||
      !focusedValue) {
    return NO;
  }
  AXUIElementRef focused = (AXUIElementRef)focusedValue;
  AXUIElementSetMessagingTimeout(focused, kAXMessagingTimeoutSec);

  BOOL ok = NO;
  CFTypeRef rangeValue = NULL;
  if (AXUIElementCopyAttributeValue(focused, kAXSelectedTextRangeAttribute, &rangeValue) ==
          kAXErrorSuccess &&
      rangeValue) {
    CFRange range = CFRangeMake(0, 0);
    if (CFGetTypeID(rangeValue) == AXValueGetTypeID() &&
        AXValueGetValue((AXValueRef)rangeValue, (AXValueType)kAXValueTypeCFRange, &range)) {
      ok = AXBoundsForRange(focused, range, outRect);
      if (!ok && range.length == 0 && range.location > 0) {
        CGRect previous;
        if (AXBoundsForRange(focused, CFRangeMake(range.location - 1, 1), &previous)) {
          *outRect = CGRectMake(CGRectGetMaxX(previous), previous.origin.y, 0,
                                previous.size.height);
          ok = YES;
        }
      }
    }
    CFRelease(rangeValue);
  }
  if (ok) {
    *outSource = @"caret";
  } else if (AXElementFrame(focused, outRect)) {
    *outSource = @"element";
    ok = YES;
  }
  CFRelease(focused);
  return ok;
}

#pragma mark - StreamingJSONArray

// Appends JSON objects to a file as a streaming array: "[\n{…},\n{…}\n]". All
// file I/O happens on the supplied serial queue so the (main-thread) event
// handler never blocks on disk.
@interface StreamingJSONArray : NSObject
- (instancetype)initWithURL:(NSURL *)url queue:(dispatch_queue_t)queue;
- (void)appendObject:(NSDictionary *)object;
- (NSUInteger)count;  // synchronous snapshot
- (void)close;        // synchronous flush + finalize
@end

@implementation StreamingJSONArray {
  NSURL *_url;
  dispatch_queue_t _queue;
  NSFileHandle *_handle;
  BOOL _opened;
  BOOL _wroteFirst;
  BOOL _closed;
  std::atomic<unsigned long> _count;
}

- (instancetype)initWithURL:(NSURL *)url queue:(dispatch_queue_t)queue {
  self = [super init];
  if (self) {
    _url = url;
    _queue = queue;
    _count = 0;
  }
  return self;
}

- (void)openLocked {
  if (_opened) return;
  _opened = YES;
  [[NSFileManager defaultManager] createFileAtPath:_url.path contents:nil attributes:nil];
  _handle = [NSFileHandle fileHandleForWritingToURL:_url error:nil];
  [_handle writeData:[@"[" dataUsingEncoding:NSUTF8StringEncoding]];
}

- (void)appendObject:(NSDictionary *)object {
  _count.fetch_add(1, std::memory_order_relaxed);
  dispatch_async(_queue, ^{
    if (_closed) return;
    NSData *json = [NSJSONSerialization dataWithJSONObject:object
                                                   options:NSJSONWritingSortedKeys
                                                     error:nil];
    if (!json) return;
    [self openLocked];
    NSString *prefix = _wroteFirst ? @",\n" : @"\n";
    _wroteFirst = YES;
    [_handle writeData:[prefix dataUsingEncoding:NSUTF8StringEncoding]];
    [_handle writeData:json];
  });
}

- (NSUInteger)count {
  return (NSUInteger)_count.load(std::memory_order_relaxed);
}

- (void)close {
  dispatch_sync(_queue, ^{
    if (_closed) return;
    _closed = YES;
    if (!_opened) {
      // No events — still emit a valid empty array.
      NSData *empty = [@"[]" dataUsingEncoding:NSUTF8StringEncoding];
      [empty writeToURL:_url atomically:YES];
      return;
    }
    [_handle writeData:[@"\n]" dataUsingEncoding:NSUTF8StringEncoding]];
    [_handle closeFile];
    _handle = nil;
  });
}

@end

#pragma mark - InputTrack

// Declared up front so the C tap callback (a free function) can message it.
@interface InputTrack ()
- (void)handleCGEvent:(CGEventRef)event type:(CGEventType)type;
@end

@implementation InputTrack {
  RecordingOptions _options;
  NSURL *_outputDirectory;

  id _monitor;  // NSEvent fallback monitor (used only if the tap can't be made)
  CFMachPortRef _eventTap;
  CFRunLoopSourceRef _tapSource;
  CFRunLoopRef _tapRunLoop;
  NSThread *_tapThread;
  dispatch_semaphore_t _tapReady;  // signalled once the tap thread's loop is live
  dispatch_source_t _sampler;
  dispatch_queue_t _writeQueue;

  StreamingJSONArray *_moves;
  StreamingJSONArray *_clicks;
  StreamingJSONArray *_keys;
  StreamingJSONArray *_caret;
  CursorCatalog *_cursorCatalog;

  // Text-caret capture (Accessibility). Active only with keystroke capture AND
  // an Accessibility grant. AX reads run on _axQueue, never the tap thread.
  dispatch_queue_t _axQueue;
  AXUIElementRef _systemWide;
  std::atomic<bool> _caretQueryScheduled;

  CGRect _displayBounds;
  CGDirectDisplayID _displayId;

  CGPoint _startPoint;   // pointer location sampled at recording start
  BOOL _haveStartPoint;

  double _hostStartMs;
  double _videoStartHostMs;  // first-frame host time; cursor timeline origin
  double _startedAtUnixMs;
  double _unixOffset;
  double _endProcessMs;

  NSString *_currentCursorId;  // guarded by _cursorIdLock (read on tap thread)
  os_unfair_lock _cursorIdLock;
  std::atomic<double> _lastRealMoveMs;
  BOOL _keyStrokesActive;

  std::atomic<bool> _paused;
  std::atomic<bool> _stopping;
  std::atomic<bool> _finished;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _currentCursorId = @"arrow";
    _cursorIdLock = OS_UNFAIR_LOCK_INIT;
    _tapReady = dispatch_semaphore_create(0);
    _paused = false;
    _stopping = false;
    _finished = false;
    _lastRealMoveMs = -1e9;
    _caretQueryScheduled = false;
  }
  return self;
}

- (void)dealloc {
  if (_systemWide) {
    CFRelease(_systemWide);
    _systemWide = NULL;
  }
}

- (BOOL)isEnabled {
  return _options.captureInput;
}

- (void)setOutputDirectory:(NSURL *)directory {
  _outputDirectory = directory;
}

- (NSURL *)urlForFile:(NSString *)name {
  return [_outputDirectory URLByAppendingPathComponent:name];
}

// Whether key capture is actually permitted right now (Input Monitoring).
static BOOL InputMonitoringGranted() {
  if (@available(macOS 10.15, *)) {
    return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted;
  }
  return YES;
}

- (BOOL)startWithHostStartMs:(double)hostStartMs
              startedAtUnixMs:(double)startedAtUnixMs
                        error:(NSError **)error {
  if (!_options.captureInput) return YES;

  _hostStartMs = hostStartMs;
  _startedAtUnixMs = startedAtUnixMs;
  _unixOffset = startedAtUnixMs - hostStartMs;

  _displayId = _options.target.displayId ? _options.target.displayId : CGMainDisplayID();
  _displayBounds = CGDisplayBounds(_displayId);

  // Sample where the pointer sits the instant recording starts. Event-based
  // capture emits nothing until the mouse first moves, so without this a
  // stationary opening leaves the cursor with no sample at t=0. Read directly
  // from CoreGraphics (independent of the tap, which may not be live yet).
  _startPoint = [self currentDisplayPoint];
  _haveStartPoint = YES;

  _writeQueue = dispatch_queue_create("com.openscreen.input.write", DISPATCH_QUEUE_SERIAL);
  _moves = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kMouseMovesFilename]
                                             queue:_writeQueue];
  _clicks = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kMouseClicksFilename]
                                              queue:_writeQueue];

  _keyStrokesActive = _options.captureKeyStrokes && InputMonitoringGranted();
  if (_keyStrokesActive) {
    _keys = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kKeyStrokesFilename]
                                              queue:_writeQueue];
    // Caret positions let the editor hide the cursor while typing and point
    // auto-zoom at the insertion point. Needs Accessibility (already part of
    // the app's required permissions); keys are still recorded without it.
    if (AXIsProcessTrusted()) {
      _systemWide = AXUIElementCreateSystemWide();
      if (_systemWide) {
        AXUIElementSetMessagingTimeout(_systemWide, kAXMessagingTimeoutSec);
        _axQueue = dispatch_queue_create("com.openscreen.input.caret", DISPATCH_QUEUE_SERIAL);
        _caret = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kTypingCaretFilename]
                                                   queue:_writeQueue];
      }
    }
  }

  // Primary: a listen-only HID-level CGEventTap on a dedicated thread. It
  // captures every movement system-wide — including over our own recorder UI,
  // before coalescing, and independent of the main run loop — so tracking is
  // live the instant recording starts. Falls back to an NSEvent global monitor
  // (with coalescing disabled) only if the tap can't be created.
  if (![self startEventTap]) {
    dispatch_block_t installNow = ^{
      [NSEvent setMouseCoalescingEnabled:NO];
      [self installMonitor];
    };
    if ([NSThread isMainThread]) {
      installNow();
    } else {
      dispatch_sync(dispatch_get_main_queue(), installNow);
    }
  }

  // The NSCursor catalog build (38 cursors → render all reps + PNG-encode +
  // disk-write) is slow and main-thread-bound. Doing it inline before
  // installing the monitor previously delayed capture by ~2 s and dropped the
  // opening movements, so it now runs asynchronously *after* the monitor is
  // live. Until it completes, moves are stamped with the default cursorId.
  if (_options.captureCursorShapes) {
    __weak InputTrack *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf buildCursorCatalogAndStartSampler];
    });
  }
  return YES;
}

- (void)buildCursorCatalogAndStartSampler {
  // A very short recording may stop before this runs — skip if so.
  if (_finished.load(std::memory_order_relaxed) ||
      _stopping.load(std::memory_order_relaxed)) {
    return;
  }
  _cursorCatalog = [[CursorCatalog alloc] init];
  [_cursorCatalog buildIntoImagesDirectory:[self urlForFile:kCursorImagesFolder]];
  [self setSafeCursorId:[_cursorCatalog resolveCurrentCursorId]];
  [self startCursorSampler];
}

- (void)installMonitor {
  NSEventMask mask = NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged |
                     NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged |
                     NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp |
                     NSEventMaskRightMouseDown | NSEventMaskRightMouseUp |
                     NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp;
  if (_keyStrokesActive) {
    mask |= NSEventMaskKeyDown | NSEventMaskKeyUp;
  }
  __weak InputTrack *weakSelf = self;
  _monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask
                                                    handler:^(NSEvent *event) {
    [weakSelf handleEvent:event];
  }];
}

- (void)startCursorSampler {
  _sampler = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                    dispatch_get_main_queue());
  uint64_t interval = (uint64_t)(kCursorSampleInterval * NSEC_PER_SEC);
  dispatch_source_set_timer(_sampler, dispatch_time(DISPATCH_TIME_NOW, interval),
                            interval, interval / 10);
  __weak InputTrack *weakSelf = self;
  dispatch_source_set_event_handler(_sampler, ^{ [weakSelf sampleCursor]; });
  dispatch_resume(_sampler);
}

#pragma mark - Coordinate mapping (main thread)

- (CGPoint)displayPointFromGlobal:(CGPoint)global {
  return CGPointMake(global.x - _displayBounds.origin.x,
                     global.y - _displayBounds.origin.y);
}

- (CGPoint)displayPointForEvent:(NSEvent *)event {
  // CGEventGetLocation is already top-left global (points), matching the
  // CGDisplayBounds coordinate space — so a simple origin subtract yields the
  // display-relative, top-left point Screen Studio stores.
  CGEventRef cg = event.CGEvent;
  CGPoint global = cg ? CGEventGetLocation(cg) : CGPointZero;
  return [self displayPointFromGlobal:global];
}

- (CGPoint)currentDisplayPoint {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint global = event ? CGEventGetLocation(event) : CGPointZero;
  if (event) CFRelease(event);
  return [self displayPointFromGlobal:global];
}

#pragma mark - Event handling (main thread)

- (BOOL)isAcceptingEvents {
  return !_paused.load(std::memory_order_relaxed) &&
         !_stopping.load(std::memory_order_relaxed);
}

// _currentCursorId is written by the sampler (main thread) and read by the
// event handlers (the tap runs on its own thread), so guard it.
- (NSString *)safeCursorId {
  os_unfair_lock_lock(&_cursorIdLock);
  NSString *value = _currentCursorId;
  os_unfair_lock_unlock(&_cursorIdLock);
  return value;
}

- (void)setSafeCursorId:(NSString *)cursorId {
  os_unfair_lock_lock(&_cursorIdLock);
  _currentCursorId = cursorId;
  os_unfair_lock_unlock(&_cursorIdLock);
}

- (NSMutableDictionary *)baseEventWithType:(NSString *)type
                                  modifiers:(NSArray<NSString *> *)mods
                                  timestamp:(double)processTimeMs {
  NSMutableDictionary *dict = [NSMutableDictionary dictionary];
  dict[@"type"] = type;
  dict[@"activeModifiers"] = mods;
  dict[@"processTimeMs"] = @(processTimeMs);
  dict[@"unixTimeMs"] = @(processTimeMs + _unixOffset);
  return dict;
}

// Shared record helpers — both the CGEventTap callback (primary) and the
// NSEvent monitor fallback funnel through these. `point` is already
// display-relative (top-left logical points). May run on the tap thread.
- (void)appendMovePoint:(CGPoint)point
                dragged:(BOOL)dragged
                 button:(NSString *)button
              modifiers:(NSArray<NSString *> *)mods
                     ts:(double)processTimeMs {
  NSMutableDictionary *dict =
      [self baseEventWithType:(dragged ? @"mouseDragged" : @"mouseMoved")
                    modifiers:mods
                    timestamp:processTimeMs];
  dict[@"x"] = @(point.x);
  dict[@"y"] = @(point.y);
  if (_options.captureCursorShapes) dict[@"cursorId"] = [self safeCursorId];
  if (dragged && button) dict[@"button"] = button;
  _lastRealMoveMs.store(processTimeMs, std::memory_order_relaxed);
  [_moves appendObject:dict];
}

// Emit a `mouseMoved` at an explicit point/time/shape, bypassing the
// stationary-coalescing logic. Used to bookend the stream at session start/end
// (see -finish) so the recorded data spans the whole recording.
- (void)appendSyntheticMoveAt:(CGPoint)point
                     cursorId:(NSString *)cursorId
                           ts:(double)processTimeMs {
  NSMutableDictionary *dict = [self baseEventWithType:@"mouseMoved"
                                            modifiers:@[]
                                            timestamp:processTimeMs];
  dict[@"x"] = @(point.x);
  dict[@"y"] = @(point.y);
  if (_options.captureCursorShapes) dict[@"cursorId"] = cursorId ?: @"arrow";
  [_moves appendObject:dict];
}

- (void)appendClickPoint:(CGPoint)point
                    down:(BOOL)down
                  button:(NSString *)button
               modifiers:(NSArray<NSString *> *)mods
                      ts:(double)processTimeMs {
  NSMutableDictionary *dict = [self baseEventWithType:(down ? @"mouseDown" : @"mouseUp")
                                            modifiers:mods
                                            timestamp:processTimeMs];
  dict[@"button"] = button ?: @"left";
  dict[@"x"] = @(point.x);
  dict[@"y"] = @(point.y);
  if (_options.captureCursorShapes) dict[@"cursorId"] = [self safeCursorId];
  [_clicks appendObject:dict];
}

- (void)appendKeyCharacter:(NSString *)character
                      down:(BOOL)down
                    repeat:(BOOL)repeat
                 modifiers:(NSArray<NSString *> *)mods
                        ts:(double)processTimeMs {
  if (!_keys) return;
  NSMutableDictionary *dict = [self baseEventWithType:(down ? @"keyDown" : @"keyUp")
                                            modifiers:mods
                                            timestamp:processTimeMs];
  dict[@"character"] = character ?: @"";
  dict[@"isARepeat"] = @(down ? repeat : NO);
  [_keys appendObject:dict];
  if (down) [self scheduleCaretQuery];
}

#pragma mark - Text caret (Accessibility; _axQueue)

// Called from the tap thread / main thread. Coalesces a burst of keys into one
// delayed AX read; the flag is cleared just before the read so a key landing
// during the read schedules the next one.
- (void)scheduleCaretQuery {
  if (!_caret || !_axQueue) return;
  bool expected = false;
  if (!_caretQueryScheduled.compare_exchange_strong(expected, true)) return;
  __weak InputTrack *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kCaretQueryDelayMs * NSEC_PER_MSEC)),
                 _axQueue, ^{
                   InputTrack *strongSelf = weakSelf;
                   if (!strongSelf) return;
                   strongSelf->_caretQueryScheduled.store(false);
                   [strongSelf sampleCaret];
                 });
}

- (void)sampleCaret {
  if (![self isAcceptingEvents] || !_systemWide) return;
  CGRect rect = CGRectZero;
  NSString *source = nil;
  if (!CopyFocusedCaretRect(_systemWide, &rect, &source)) return;
  // Only keep carets on the recorded display (another screen's field would map
  // off-video anyway).
  if (!CGRectIntersectsRect(CGRectInset(rect, -1, -1), _displayBounds)) return;
  CGPoint origin = [self displayPointFromGlobal:rect.origin];
  NSMutableDictionary *dict = [self baseEventWithType:@"caret"
                                            modifiers:@[]
                                            timestamp:HostNowMs()];
  dict[@"x"] = @(origin.x);
  dict[@"y"] = @(origin.y);
  dict[@"width"] = @(rect.size.width);
  dict[@"height"] = @(rect.size.height);
  dict[@"source"] = source ?: @"caret";
  [_caret appendObject:dict];
}

#pragma mark - CGEventTap capture (primary; dedicated thread)

static CGEventRef InputEventTapCallback(CGEventTapProxy proxy, CGEventType type,
                                        CGEventRef event, void *refcon) {
  InputTrack *track = (__bridge InputTrack *)refcon;
  [track handleCGEvent:event type:type];
  return event;  // listen-only — never modify the stream
}

- (void)handleCGEvent:(CGEventRef)event type:(CGEventType)type {
  // The system disables a tap that blocks too long or on a fast user switch;
  // re-enable and carry on.
  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    if (_eventTap) CGEventTapEnable(_eventTap, true);
    return;
  }
  if (![self isAcceptingEvents]) return;

  double processTimeMs = HostNowMs();
  CGPoint point = [self displayPointFromGlobal:CGEventGetLocation(event)];
  NSArray<NSString *> *mods = CGModifierStrings(CGEventGetFlags(event));

  switch (type) {
    case kCGEventMouseMoved:
      [self appendMovePoint:point dragged:NO button:nil modifiers:mods ts:processTimeMs];
      break;
    case kCGEventLeftMouseDragged:
      [self appendMovePoint:point dragged:YES button:@"left" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventRightMouseDragged:
      [self appendMovePoint:point dragged:YES button:@"right" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventOtherMouseDragged:
      [self appendMovePoint:point dragged:YES button:@"other" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventLeftMouseDown:
      [self appendClickPoint:point down:YES button:@"left" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventLeftMouseUp:
      [self appendClickPoint:point down:NO button:@"left" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventRightMouseDown:
      [self appendClickPoint:point down:YES button:@"right" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventRightMouseUp:
      [self appendClickPoint:point down:NO button:@"right" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventOtherMouseDown:
      [self appendClickPoint:point down:YES button:@"other" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventOtherMouseUp:
      [self appendClickPoint:point down:NO button:@"other" modifiers:mods ts:processTimeMs];
      break;
    case kCGEventKeyDown:
    case kCGEventKeyUp: {
      if (!_keys) break;
      BOOL down = (type == kCGEventKeyDown);
      BOOL repeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
      UniChar chars[8];
      UniCharCount len = 0;
      CGEventKeyboardGetUnicodeString(event, 8, &len, chars);
      NSString *character =
          len > 0 ? [NSString stringWithCharacters:chars length:len] : @"";
      [self appendKeyCharacter:character down:down repeat:repeat modifiers:mods ts:processTimeMs];
      break;
    }
    default:
      break;
  }
}

// Create a listen-only HID-level event tap: captures every movement
// system-wide (including over our own UI), before coalescing, on a dedicated
// thread independent of the main run loop. Returns NO if the tap can't be
// created (e.g. Accessibility not granted) so the caller falls back to the
// NSEvent monitor.
- (BOOL)startEventTap {
  CGEventMask mask = CGEventMaskBit(kCGEventMouseMoved) |
                     CGEventMaskBit(kCGEventLeftMouseDragged) |
                     CGEventMaskBit(kCGEventRightMouseDragged) |
                     CGEventMaskBit(kCGEventOtherMouseDragged) |
                     CGEventMaskBit(kCGEventLeftMouseDown) |
                     CGEventMaskBit(kCGEventLeftMouseUp) |
                     CGEventMaskBit(kCGEventRightMouseDown) |
                     CGEventMaskBit(kCGEventRightMouseUp) |
                     CGEventMaskBit(kCGEventOtherMouseDown) |
                     CGEventMaskBit(kCGEventOtherMouseUp);
  if (_keyStrokesActive) {
    mask |= CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp);
  }
  _eventTap = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap,
                               kCGEventTapOptionListenOnly, mask,
                               InputEventTapCallback, (__bridge void *)self);
  if (!_eventTap) return NO;

  _tapThread = [[NSThread alloc] initWithTarget:self
                                       selector:@selector(tapThreadMain)
                                         object:nil];
  _tapThread.name = @"com.openscreen.input.tap";
  [_tapThread start];
  return YES;
}

- (void)tapThreadMain {
  @autoreleasepool {
    _tapRunLoop = CFRunLoopGetCurrent();
    _tapSource = CFMachPortCreateRunLoopSource(NULL, _eventTap, 0);
    CFRunLoopAddSource(_tapRunLoop, _tapSource, kCFRunLoopCommonModes);
    CGEventTapEnable(_eventTap, true);
    // Signal that the run loop + tap are live so -finish can safely stop us.
    dispatch_semaphore_signal(_tapReady);
    CFRunLoopRun();  // returns once -finish calls CFRunLoopStop
    CFRunLoopRemoveSource(_tapRunLoop, _tapSource, kCFRunLoopCommonModes);
    if (_tapSource) { CFRelease(_tapSource); _tapSource = NULL; }
    if (_eventTap) { CFRelease(_eventTap); _eventTap = NULL; }
    _tapRunLoop = NULL;
  }
}

#pragma mark - NSEvent monitor capture (fallback)

- (void)handleEvent:(NSEvent *)event {
  if (![self isAcceptingEvents]) return;
  double processTimeMs = event.timestamp * 1000.0;
  NSArray<NSString *> *mods = ModifierStrings(event.modifierFlags);
  CGPoint point = [self displayPointForEvent:event];
  switch (event.type) {
    case NSEventTypeMouseMoved:
      [self appendMovePoint:point dragged:NO button:nil modifiers:mods ts:processTimeMs];
      break;
    case NSEventTypeLeftMouseDragged:
    case NSEventTypeRightMouseDragged:
    case NSEventTypeOtherMouseDragged:
      [self appendMovePoint:point
                    dragged:YES
                     button:[self buttonStringForType:event.type]
                  modifiers:mods
                         ts:processTimeMs];
      break;
    case NSEventTypeLeftMouseDown:
    case NSEventTypeRightMouseDown:
    case NSEventTypeOtherMouseDown:
      [self appendClickPoint:point
                        down:YES
                      button:[self buttonStringForType:event.type]
                   modifiers:mods
                          ts:processTimeMs];
      break;
    case NSEventTypeLeftMouseUp:
    case NSEventTypeRightMouseUp:
    case NSEventTypeOtherMouseUp:
      [self appendClickPoint:point
                        down:NO
                      button:[self buttonStringForType:event.type]
                   modifiers:mods
                          ts:processTimeMs];
      break;
    case NSEventTypeKeyDown:
      [self appendKeyCharacter:(event.characters ?: @"")
                          down:YES
                        repeat:event.isARepeat
                     modifiers:mods
                            ts:processTimeMs];
      break;
    case NSEventTypeKeyUp:
      [self appendKeyCharacter:(event.characters ?: @"")
                          down:NO
                        repeat:NO
                     modifiers:mods
                            ts:processTimeMs];
      break;
    default:
      break;
  }
}

- (NSString *)buttonStringForType:(NSEventType)type {
  switch (type) {
    case NSEventTypeRightMouseDown:
    case NSEventTypeRightMouseUp:
    case NSEventTypeRightMouseDragged:
      return @"right";
    case NSEventTypeOtherMouseDown:
    case NSEventTypeOtherMouseUp:
    case NSEventTypeOtherMouseDragged:
      return @"other";
    default:
      return @"left";
  }
}

// Resolve the live cursor shape; when it changes without a recent real move,
// synthesize a mouseMoved carrying the new cursorId so the shape timeline stays
// accurate even while the pointer is stationary (matches Screen Studio).
- (void)sampleCursor {
  if (![self isAcceptingEvents] || !_cursorCatalog) return;
  NSString *resolved = [_cursorCatalog resolveCurrentCursorId];
  if ([resolved isEqualToString:[self safeCursorId]]) return;

  [self setSafeCursorId:resolved];
  double now = HostNowMs();
  if (now - _lastRealMoveMs.load(std::memory_order_relaxed) <= kSynthesizedMoveGapMs) {
    return;  // a real move carried it
  }

  CGPoint point = [self currentDisplayPoint];
  NSMutableDictionary *dict = [self baseEventWithType:@"mouseMoved"
                                            modifiers:ModifierStrings(NSEvent.modifierFlags)
                                            timestamp:now];
  dict[@"x"] = @(point.x);
  dict[@"y"] = @(point.y);
  dict[@"cursorId"] = resolved;
  [_moves appendObject:dict];
}

#pragma mark - Lifecycle

- (void)setVideoStartHostMs:(double)hostMs {
  BOOL firstAnchor = _videoStartHostMs <= 0;
  _videoStartHostMs = hostMs;
  // Re-sample the pointer at the cursor-timeline origin (the first video
  // frame), since that — not recording start — is the timestamp the start
  // bookend is stamped with (anchorMs). Sampling here keeps the held opening
  // position correct even if the pointer moved during the brief gap between
  // recording start and the first frame. Only on the first anchor; the early
  // sample in -startWithHostStartMs is the fallback when no frame ever anchors
  // the timeline.
  if (firstAnchor) {
    _startPoint = [self currentDisplayPoint];
    _haveStartPoint = YES;
  }
}

- (void)setPaused:(BOOL)paused {
  _paused.store(paused, std::memory_order_relaxed);
}

- (void)markStopping {
  _stopping.store(true, std::memory_order_relaxed);
}

- (void)finish {
  if (!_options.captureInput) return;
  if (_finished.exchange(true)) return;
  _stopping.store(true, std::memory_order_relaxed);
  _endProcessMs = HostNowMs();

  // Stop the event tap on its dedicated thread. Wait until the thread reported
  // its run loop is live (bounded), then disable the tap and stop the loop;
  // the tap thread itself releases the tap + source as the loop returns.
  if (_tapThread) {
    dispatch_semaphore_wait(_tapReady,
                            dispatch_time(DISPATCH_TIME_NOW, 2LL * NSEC_PER_SEC));
    if (_eventTap) CGEventTapEnable(_eventTap, false);
    if (_tapRunLoop) CFRunLoopStop(_tapRunLoop);
  }

  // Tear down AppKit-affine resources on the main thread. dispatch_sync here
  // serialises against any in-flight handler/sampler (both on main), so no
  // append can race the close below.
  dispatch_block_t teardown = ^{
    // Restore the process-wide coalescing default we disabled in -start.
    [NSEvent setMouseCoalescingEnabled:YES];
    if (_monitor) {
      [NSEvent removeMonitor:_monitor];
      _monitor = nil;
    }
    if (_sampler) {
      dispatch_source_cancel(_sampler);
      _sampler = nil;
    }
  };
  if ([NSThread isMainThread]) {
    teardown();
  } else {
    dispatch_sync(dispatch_get_main_queue(), teardown);
  }

  // Bookend the move stream so the recorded cursor data covers the whole
  // session even when the pointer was stationary at the very start (mouse not
  // yet moved) or end (parked on the Stop button). The start sample is stamped
  // at the cursor timeline origin (the video's first-frame anchor) so it maps
  // to source time 0; the end sample is stamped at the session-end host time.
  // Appends run on _writeQueue and the close below dispatch_syncs that queue,
  // so they are flushed in order before finalize. The renderer sorts by time,
  // so out-of-order insertion (start has the smallest t) is fine.
  if (_options.captureInput) {
    double anchorMs = _videoStartHostMs > 0 ? _videoStartHostMs : _hostStartMs;
    if (_haveStartPoint) {
      [self appendSyntheticMoveAt:_startPoint cursorId:@"arrow" ts:anchorMs];
    }
    [self appendSyntheticMoveAt:[self currentDisplayPoint]
                       cursorId:[self safeCursorId]
                             ts:_endProcessMs];
  }

  // Drain any in-flight caret read (it no-ops now that _stopping is set) so
  // its append can't race the close below.
  if (_axQueue) dispatch_sync(_axQueue, ^{});

  [_moves close];
  [_clicks close];
  [_keys close];
  [_caret close];

  if (_cursorCatalog) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:[_cursorCatalog catalogEntries]
                                                  options:NSJSONWritingSortedKeys
                                                    error:nil];
    if (json) [json writeToURL:[self urlForFile:kCursorsInfoFile] atomically:YES];
  }
}

#pragma mark - Manifest

- (NSDictionary *)filesDictionary {
  if (!_options.captureInput) return nil;
  NSMutableDictionary *files = [NSMutableDictionary dictionary];
  files[@"mouseMoves"] = [self urlForFile:kMouseMovesFilename].path;
  files[@"mouseClicks"] = [self urlForFile:kMouseClicksFilename].path;
  if (_keys) files[@"keyStrokes"] = [self urlForFile:kKeyStrokesFilename].path;
  if (_caret) files[@"typingCaret"] = [self urlForFile:kTypingCaretFilename].path;
  if (_cursorCatalog) files[@"cursors"] = [self urlForFile:kCursorsInfoFile].path;
  return files;
}

- (NSDictionary *)metadata {
  if (!_options.captureInput) return nil;
  NSMutableDictionary *meta = [NSMutableDictionary dictionary];
  meta[@"source"] = @"input";
  meta[@"captureKeyStrokes"] = @(_keyStrokesActive);
  meta[@"captureTypingCaret"] = @(_caret != nil);
  meta[@"captureCursorShapes"] = @(_options.captureCursorShapes);
  meta[@"mouseMovesFilename"] = kMouseMovesFilename;
  meta[@"mouseClicksFilename"] = kMouseClicksFilename;
  if (_keys) meta[@"keyStrokesFilename"] = kKeyStrokesFilename;
  if (_caret) meta[@"typingCaretFilename"] = kTypingCaretFilename;
  if (_cursorCatalog) {
    meta[@"cursorsInfoFile"] = kCursorsInfoFile;
    meta[@"cursorImagesFolder"] = kCursorImagesFolder;
  }
  meta[@"displayId"] = @(_displayId);
  meta[@"displayBoundsPoints"] = @{
    @"x" : @(_displayBounds.origin.x),
    @"y" : @(_displayBounds.origin.y),
    @"width" : @(_displayBounds.size.width),
    @"height" : @(_displayBounds.size.height),
  };
  // Anchor the timeline to the screen video's first-frame host time so cursor
  // source time 0 == video source time 0. Falls back to the stream-start host
  // time when there's no video (e.g. it never started).
  double anchorMs = _videoStartHostMs > 0 ? _videoStartHostMs : _hostStartMs;
  double endProcessMs = _endProcessMs > 0 ? _endProcessMs : HostNowMs();
  meta[@"session"] = @{
    @"processTimeStartMs" : @(anchorMs),
    @"processTimeEndMs" : @(endProcessMs),
    @"unixStartMs" : @(_startedAtUnixMs + (anchorMs - _hostStartMs)),
    @"unixEndMs" : @(_startedAtUnixMs + (endProcessMs - _hostStartMs)),
    @"durationMs" : @(endProcessMs - anchorMs),
    @"mouseMovesCount" : @([_moves count]),
    @"mouseClicksCount" : @([_clicks count]),
    @"keyStrokesCount" : @(_keys ? [_keys count] : 0),
    @"typingCaretCount" : @(_caret ? [_caret count] : 0),
  };
  return meta;
}

@end
