#include "InputTrack.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <IOKit/hidsystem/IOHIDLib.h>

#include <atomic>

#include "CursorTrack.h"

// Sidecar file names — Screen Studio uses a session index suffix; this session
// model accumulates pauses rather than splitting, so the index is always 0.
static NSString *const kMouseMovesFilename = @"mousemoves-0.json";
static NSString *const kMouseClicksFilename = @"mouseclicks-0.json";
static NSString *const kKeyStrokesFilename = @"keystrokes-0.json";
static NSString *const kCursorsInfoFile = @"cursors.json";
static NSString *const kCursorImagesFolder = @"cursors";

// Cursor sampler interval. 60 Hz mirrors Screen Studio's display-link cadence
// closely enough to catch shape changes promptly without burning the main
// thread. A synthesized move is only emitted when the shape changed and no real
// move carried it within this window.
static const NSTimeInterval kCursorSampleInterval = 1.0 / 60.0;
static const double kSynthesizedMoveGapMs = 30.0;

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

@implementation InputTrack {
  RecordingOptions _options;
  NSURL *_outputDirectory;

  id _monitor;
  dispatch_source_t _sampler;
  dispatch_queue_t _writeQueue;

  StreamingJSONArray *_moves;
  StreamingJSONArray *_clicks;
  StreamingJSONArray *_keys;
  CursorCatalog *_cursorCatalog;

  CGRect _displayBounds;
  CGDirectDisplayID _displayId;

  double _hostStartMs;
  double _startedAtUnixMs;
  double _unixOffset;
  double _endProcessMs;

  NSString *_currentCursorId;
  double _lastRealMoveMs;
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
    _paused = false;
    _stopping = false;
    _finished = false;
    _lastRealMoveMs = -1e9;
  }
  return self;
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

  _writeQueue = dispatch_queue_create("com.openscreen.input.write", DISPATCH_QUEUE_SERIAL);
  _moves = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kMouseMovesFilename]
                                             queue:_writeQueue];
  _clicks = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kMouseClicksFilename]
                                              queue:_writeQueue];

  _keyStrokesActive = _options.captureKeyStrokes && InputMonitoringGranted();
  if (_keyStrokesActive) {
    _keys = [[StreamingJSONArray alloc] initWithURL:[self urlForFile:kKeyStrokesFilename]
                                              queue:_writeQueue];
  }

  // AppKit (NSEvent monitor, NSCursor catalog) must be touched on the main
  // thread; -start runs on a background worker.
  dispatch_block_t setup = ^{
    if (_options.captureCursorShapes) {
      _cursorCatalog = [[CursorCatalog alloc] init];
      [_cursorCatalog buildIntoImagesDirectory:[self urlForFile:kCursorImagesFolder]];
      _currentCursorId = [_cursorCatalog resolveCurrentCursorId];
      [self startCursorSampler];
    }
    [self installMonitor];
  };
  if ([NSThread isMainThread]) {
    setup();
  } else {
    dispatch_sync(dispatch_get_main_queue(), setup);
  }
  return YES;
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

- (NSMutableDictionary *)baseEventWithType:(NSString *)type
                                  modifiers:(NSEventModifierFlags)flags
                                  timestamp:(double)processTimeMs {
  NSMutableDictionary *dict = [NSMutableDictionary dictionary];
  dict[@"type"] = type;
  dict[@"activeModifiers"] = ModifierStrings(flags);
  dict[@"processTimeMs"] = @(processTimeMs);
  dict[@"unixTimeMs"] = @(processTimeMs + _unixOffset);
  return dict;
}

- (void)handleEvent:(NSEvent *)event {
  if (![self isAcceptingEvents]) return;

  double processTimeMs = event.timestamp * 1000.0;
  NSEventType type = event.type;

  switch (type) {
    case NSEventTypeMouseMoved:
    case NSEventTypeLeftMouseDragged:
    case NSEventTypeRightMouseDragged:
    case NSEventTypeOtherMouseDragged: {
      CGPoint point = [self displayPointForEvent:event];
      BOOL dragged = (type != NSEventTypeMouseMoved);
      NSMutableDictionary *dict =
          [self baseEventWithType:(dragged ? @"mouseDragged" : @"mouseMoved")
                        modifiers:event.modifierFlags
                        timestamp:processTimeMs];
      dict[@"x"] = @(point.x);
      dict[@"y"] = @(point.y);
      if (_cursorCatalog) dict[@"cursorId"] = _currentCursorId;
      if (dragged) dict[@"button"] = [self buttonStringForType:type];
      _lastRealMoveMs = processTimeMs;
      [_moves appendObject:dict];
      break;
    }
    case NSEventTypeLeftMouseDown:
    case NSEventTypeRightMouseDown:
    case NSEventTypeOtherMouseDown:
    case NSEventTypeLeftMouseUp:
    case NSEventTypeRightMouseUp:
    case NSEventTypeOtherMouseUp: {
      CGPoint point = [self displayPointForEvent:event];
      BOOL isDown = (type == NSEventTypeLeftMouseDown ||
                     type == NSEventTypeRightMouseDown ||
                     type == NSEventTypeOtherMouseDown);
      NSMutableDictionary *dict =
          [self baseEventWithType:(isDown ? @"mouseDown" : @"mouseUp")
                        modifiers:event.modifierFlags
                        timestamp:processTimeMs];
      dict[@"button"] = [self buttonStringForType:type];
      dict[@"x"] = @(point.x);
      dict[@"y"] = @(point.y);
      if (_cursorCatalog) dict[@"cursorId"] = _currentCursorId;
      [_clicks appendObject:dict];
      break;
    }
    case NSEventTypeKeyDown:
    case NSEventTypeKeyUp: {
      if (!_keys) break;
      NSMutableDictionary *dict =
          [self baseEventWithType:(type == NSEventTypeKeyDown ? @"keyDown" : @"keyUp")
                        modifiers:event.modifierFlags
                        timestamp:processTimeMs];
      dict[@"character"] = event.characters ?: @"";
      dict[@"isARepeat"] = @(type == NSEventTypeKeyDown ? event.isARepeat : NO);
      [_keys appendObject:dict];
      break;
    }
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
  if ([resolved isEqualToString:_currentCursorId]) return;

  _currentCursorId = resolved;
  double now = HostNowMs();
  if (now - _lastRealMoveMs <= kSynthesizedMoveGapMs) return;  // a real move carried it

  CGPoint point = [self currentDisplayPoint];
  NSMutableDictionary *dict = [self baseEventWithType:@"mouseMoved"
                                            modifiers:NSEvent.modifierFlags
                                            timestamp:now];
  dict[@"x"] = @(point.x);
  dict[@"y"] = @(point.y);
  dict[@"cursorId"] = resolved;
  [_moves appendObject:dict];
}

#pragma mark - Lifecycle

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

  // Tear down AppKit-affine resources on the main thread. dispatch_sync here
  // serialises against any in-flight handler/sampler (both on main), so no
  // append can race the close below.
  dispatch_block_t teardown = ^{
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

  [_moves close];
  [_clicks close];
  [_keys close];

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
  if (_cursorCatalog) files[@"cursors"] = [self urlForFile:kCursorsInfoFile].path;
  return files;
}

- (NSDictionary *)metadata {
  if (!_options.captureInput) return nil;
  NSMutableDictionary *meta = [NSMutableDictionary dictionary];
  meta[@"source"] = @"input";
  meta[@"captureKeyStrokes"] = @(_keyStrokesActive);
  meta[@"captureCursorShapes"] = @(_options.captureCursorShapes);
  meta[@"mouseMovesFilename"] = kMouseMovesFilename;
  meta[@"mouseClicksFilename"] = kMouseClicksFilename;
  if (_keys) meta[@"keyStrokesFilename"] = kKeyStrokesFilename;
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
  double endProcessMs = _endProcessMs > 0 ? _endProcessMs : HostNowMs();
  meta[@"session"] = @{
    @"processTimeStartMs" : @(_hostStartMs),
    @"processTimeEndMs" : @(endProcessMs),
    @"unixStartMs" : @(_startedAtUnixMs),
    @"unixEndMs" : @(_startedAtUnixMs + (endProcessMs - _hostStartMs)),
    @"durationMs" : @(endProcessMs - _hostStartMs),
    @"mouseMovesCount" : @([_moves count]),
    @"mouseClicksCount" : @([_clicks count]),
    @"keyStrokesCount" : @(_keys ? [_keys count] : 0),
  };
  return meta;
}

@end
