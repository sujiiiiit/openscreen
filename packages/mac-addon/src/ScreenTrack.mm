#include "ScreenTrack.h"

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>

#include <sys/sysctl.h>

#include <atomic>
#include <vector>

#include "Events.h"

// SDR pipeline pixel format. Matches BetterCapture's choice (and Apple's
// recommended SDR default): BGRA 8-bit. A previous iteration here used
// `ARGB2101010LEPacked` (10-bit RGB) to preserve more capture precision —
// OBS does the same — but the result was a "10-bit Display-P3 throughout"
// pipeline that diverged from BetterCapture's output in two ways the user
// could see:
//   1. Colors appeared more saturated on P3 displays (correctly P3, but
//      different from BetterCapture's BT.709-tagged output).
//   2. Some downstream tools / players mishandle 10-bit SDR HEVC.
// Sticking with BGRA 8-bit makes our SDR output bit-for-bit comparable to
// BetterCapture (same primaries, same matrix, same bit depth, same encoder
// profile).
static const OSType kSDRPixelFormat = kCVPixelFormatType_32BGRA;

static BOOL IsAppleSiliconCPU(void) {
  int isAppleSilicon = 0;
  size_t size = sizeof(isAppleSilicon);
  return sysctlbyname("hw.optional.arm64", &isAppleSilicon, &size, NULL, 0) == 0 &&
         isAppleSilicon == 1;
}

static AVVideoCodecType DefaultScreenCodec(void) {
  return IsAppleSiliconCPU() ? AVVideoCodecTypeHEVC : AVVideoCodecTypeH264;
}

// Map the JS `videoCodec` string onto an AVVideoCodecType. Returns nil if the
// string is empty/unknown (caller falls back to DefaultScreenCodec).
//
// Two codecs intentionally exposed: HEVC (default) and H.264 (compat).
// ProRes was dropped (300+ Mbps editing-only files); HEVC-with-Alpha and
// HDR were dropped because the pipeline emits universally-playable BT.709
// SDR — alpha needs niche post-editing workflows and HDR needs an HDR
// display + downstream tools that handle BT.2020/PQ correctly.
static AVVideoCodecType CodecTypeForKey(NSString *key) {
  if (key.length == 0) return nil;
  if ([key isEqualToString:@"hevc"]) return AVVideoCodecTypeHEVC;
  if ([key isEqualToString:@"h264"]) return AVVideoCodecTypeH264;
  return nil;
}

static NSString *KeyForCodecType(AVVideoCodecType codec) {
  if ([codec isEqualToString:AVVideoCodecTypeHEVC]) return @"hevc";
  if ([codec isEqualToString:AVVideoCodecTypeH264]) return @"h264";
  return codec ?: @"";
}

// Bits-per-pixel multipliers, one per quality preset. HEVC needs roughly
// half the bitrate of H.264 for the same perceived quality, so the HEVC
// column is ⅔ to ¾ of H.264 at every tier.
//
//   Low    H.264 0.04   HEVC 0.02   — long captures, storage-bound
//   Medium H.264 0.20   HEVC 0.15   — balanced
//   High   H.264 0.60   HEVC 0.40   — default, matches BetterCapture "High"
//   XHigh  H.264 1.20   HEVC 0.80   — 2× of High; near-lossless on screen content
//   Max    H.264 2.40   HEVC 1.60   — 4× of High; minimal compression
//
// XHigh / Max are above the typical "diminishing returns" knee for HEVC —
// VideoToolbox won't always spend every requested bit (a static UI frame
// produces a tiny encoded payload regardless of the budget), so the
// effective file size grows sub-linearly past XHigh. Useful when the user
// wants to remove encoding as a quality variable entirely.
static double BitsPerPixelForCodec(AVVideoCodecType codec, NSString *quality) {
  BOOL isHEVC = [codec isEqualToString:AVVideoCodecTypeHEVC];
  if ([quality isEqualToString:@"low"])    return isHEVC ? 0.02 : 0.04;
  if ([quality isEqualToString:@"medium"]) return isHEVC ? 0.15 : 0.20;
  if ([quality isEqualToString:@"xhigh"])  return isHEVC ? 0.80 : 1.20;
  if ([quality isEqualToString:@"max"])    return isHEVC ? 1.60 : 2.40;
  return isHEVC ? 0.40 : 0.60;  // Default = High.
}

static AVFileType FileTypeForContainer(NSString *container) {
  if ([container isEqualToString:@"mp4"]) return AVFileTypeMPEG4;
  return AVFileTypeQuickTimeMovie;
}

static BOOL CGRectFromFrameAttachment(id value, CGRect *rect) {
  if (!value) return NO;
  if ([value isKindOfClass:[NSValue class]]) {
    *rect = [(NSValue *)value rectValue];
    return YES;
  }
  if ([value isKindOfClass:[NSDictionary class]]) {
    return CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value, rect);
  }
  return NO;
}

static NSDictionary *DictionaryFromCGRect(CGRect rect) {
  return @{
    @"x": @(rect.origin.x),
    @"y": @(rect.origin.y),
    @"width": @(rect.size.width),
    @"height": @(rect.size.height),
  };
}

static NSInteger EvenDimensionFromDouble(double value) {
  NSInteger dimension = (NSInteger)llround(value);
  if (dimension % 2 != 0) dimension -= 1;
  return MAX(2, dimension);
}

@implementation ScreenTrack {
  RecordingOptions _options;
  NSString *_sessionId;
  NSURL *_url;

  AVAssetWriter *_writer;
  AVAssetWriterInput *_videoInput;
  AVAssetWriterInput *_systemAudioInput;
  AVAssetWriterInput *_microphoneInput;
  // Cached at finish time so -metadata can still report it after the writer
  // ivar has been released (otherwise the manifest loses the error reason).
  NSError *_savedWriterError;
  AVVideoCodecType _codec;

  // Resolved (coerced) screen-recording settings. Filled in by -resolveOptions
  // before -streamConfigurationForContent: returns, used by every subsequent
  // call (writer setup, manifest). Coercion rules live in -resolveOptions
  // and mirror docs/screen-recording-addon.md.
  NSString *_resolvedCodecKey;        // "hevc" | "h264"
  NSString *_resolvedQuality;          // "low" | "medium" | "high"
  NSString *_resolvedContainer;        // "mov" | "mp4"
  NSString *_resolvedResolutionMode;   // "native" | "logical"
  int _resolvedFrameRate;              // 0 (native) | 24 | 30 | 60
  double _resolvedBitsPerPixel;

  dispatch_queue_t _videoQueue;
  // Single lock around session-start + AVAssetWriter status checks. Individual
  // -appendSampleBuffer: calls on a given AVAssetWriterInput are thread-safe
  // on their own.
  NSLock *_writerLock;
  BOOL _sessionStarted;
  CMTime _sessionStartTime;
  BOOL _writerFailed;

  // Set from the recorder thread in -markStopping, read on every sample
  // delivery from SCKit's sample-handler queue. A plain BOOL has no memory
  // barrier, so SCKit can read stale `NO` after we've already called
  // -markAsFinished on the inputs and -appendSampleBuffer: against a
  // finished input throws inside AVFoundation. atomic with acquire/release
  // gives the SCKit thread a happens-before edge to the markStopping write.
  std::atomic<bool> _stopping;
  BOOL _started;
  BOOL _finished;
  NSInteger _droppedSystemAudioBeforeStart;
  NSInteger _droppedMicrophoneBeforeStart;
  NSInteger _videoSamplesAppended;
  NSInteger _videoSamplesDropped;
  BOOL _videoBackpressureEventSent;
  NSInteger _completeFrameCount;
  NSInteger _idleFrameCount;
  NSInteger _blankFrameCount;
  NSInteger _suspendedFrameCount;
  NSInteger _startedFrameCount;
  NSInteger _stoppedFrameCount;
  NSInteger _unknownFrameCount;
  NSInteger _dirtyFrameCount;
  NSInteger _dirtyRectCount;
  NSInteger _maxDirtyRectsInFrame;
  CGRect _lastContentRect;
  BOOL _hasLastContentRect;
  CGRect _lastBoundingRect;
  BOOL _hasLastBoundingRect;
  CGRect _lastScreenRect;
  BOOL _hasLastScreenRect;
  CGFloat _lastContentScale;
  CGFloat _lastFrameScaleFactor;

  // Cached configuration values for the manifest + startup log.
  NSInteger _configuredWidth;
  NSInteger _configuredHeight;
  CGFloat _configuredScaleFactor;
  NSString *_pixelSizeSource;
  NSString *_configuredColorSpace;
  // Chosen at config time based on the target screen's gamut, so the file's
  // color tags match what SCKit captured into.
  NSString *_configuredColorPrimaries;     // AVVideoColorPrimaries_* constant
  NSString *_configuredGamut;              // "P3" | "Rec.709"
  NSInteger _configuredBitRate;
  NSInteger _configuredKeyframeInterval;
  CGRect _configuredSourceRect;
  BOOL _hasConfiguredSourceRect;

  // Pause / resume state. Guarded by _writerLock — read on every sample
  // append, mutated only by -setPaused: from the recorder session's main
  // dispatch. The append paths drop samples while _paused and shift PTS by
  // _pauseAccumulated when running, so the .mov has no gap on resume.
  BOOL _paused;
  CMTime _pauseStartHost;
  CMTime _pauseAccumulated;
  NSInteger _pauseCycleCount;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options
                       sessionId:(NSString *)sessionId {
  self = [super init];
  if (self) {
    _options = options;
    _sessionId = [sessionId copy];
    _videoQueue = dispatch_queue_create("openscreen.sck.screen", DISPATCH_QUEUE_SERIAL);
    _writerLock = [[NSLock alloc] init];
    _sessionStartTime = kCMTimeInvalid;
    _pauseStartHost = kCMTimeInvalid;
    _pauseAccumulated = kCMTimeZero;
    // std::atomic default-ctor leaves the value indeterminate pre-C++20; init
    // explicitly so the very first compare/load is well-defined.
    _stopping.store(false, std::memory_order_relaxed);
    [self resolveOptions];
  }
  return self;
}

- (void)setOutputURL:(NSURL *)url {
  _url = url;
}

- (NSString *)fileExtension {
  // _resolvedContainer is set by -resolveOptions, called during -init.
  return [_resolvedContainer isEqualToString:@"mp4"] ? @"mp4" : @"mov";
}

#pragma mark - Option resolution

// Coerce user-supplied options onto a configuration AVAssetWriter will accept.
// Rules match docs/screen-recording-addon.md and BetterCapture's
// SettingsStore coercion logic. Called once from -init; the resolved values
// live in _resolved* ivars and are read by stream / writer / manifest paths.
//
- (void)resolveOptions {
  // 1. Codec — explicit string > CPU-default.
  AVVideoCodecType codec = CodecTypeForKey(ToNSString(_options.videoCodec));
  if (!codec) codec = DefaultScreenCodec();

  // 2. Container — both HEVC and H.264 work in both MOV and MP4, so the
  // only validation is the enum itself.
  NSString *container = [ToNSString(_options.container) lowercaseString];
  if (![container isEqualToString:@"mp4"]) container = @"mov";

  // 3. Quality — bpp multiplier for the H.264 / HEVC encoder.
  NSString *quality = [ToNSString(_options.videoQuality) lowercaseString];
  if (![quality isEqualToString:@"low"] &&
      ![quality isEqualToString:@"medium"] &&
      ![quality isEqualToString:@"high"] &&
      ![quality isEqualToString:@"xhigh"] &&
      ![quality isEqualToString:@"max"]) {
    quality = @"high";
  }

  // 4. Resolution mode — "native" (× pointPixelScale) or "logical" (1×).
  NSString *resolutionMode = [ToNSString(_options.resolutionMode) lowercaseString];
  if (![resolutionMode isEqualToString:@"logical"]) resolutionMode = @"native";

  // 5. Frame rate — 0 (native), 24, 30, 60. Sentinel -1 means "fall back to
  // legacy fps" (which Bindings.mm already validated to 30 or 60).
  int frameRate = _options.frameRate;
  if (frameRate < 0) frameRate = _options.fps;
  if (frameRate != 0 && frameRate != 24 && frameRate != 30 && frameRate != 60) {
    frameRate = 60;
  }

  _codec = codec;
  _resolvedCodecKey = KeyForCodecType(codec);
  _resolvedQuality = quality;
  _resolvedContainer = container;
  _resolvedResolutionMode = resolutionMode;
  _resolvedFrameRate = frameRate;
  _resolvedBitsPerPixel = BitsPerPixelForCodec(codec, quality);
}

#pragma mark - SCKit setup

// Process-wide cache for the recording-path SCShareableContent query.
// `SCShareableContent` is a 500ms–1s+ call cold; prewarming it during
// recorder bar / picker open lets `startSync` skip the wait. TTL is short
// (3s) so freshly-opened windows aren't silently missed; `startSync` also
// invalidates + retries once if a window/app lookup returns nil. Stored
// only for the (onScreenWindowsOnly:NO, excludingDesktopWindows:NO) flag
// combo used here — the list worker uses different flags and doesn't share
// this slot.
static const NSTimeInterval kShareableContentCacheTTL = 3.0;
static NSLock *gShareableContentCacheLock = nil;
static SCShareableContent *gShareableContentCacheValue = nil;
static NSDate *gShareableContentCacheAt = nil;
static BOOL gShareableContentPrewarmInFlight = NO;

static void EnsureShareableContentCacheLock(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gShareableContentCacheLock = [[NSLock alloc] init];
  });
}

static SCShareableContent *ReadShareableContentCache(void) {
  EnsureShareableContentCacheLock();
  SCShareableContent *result = nil;
  [gShareableContentCacheLock lock];
  if (gShareableContentCacheValue && gShareableContentCacheAt) {
    NSTimeInterval age = -[gShareableContentCacheAt timeIntervalSinceNow];
    if (age >= 0 && age <= kShareableContentCacheTTL) {
      result = gShareableContentCacheValue;
    } else {
      gShareableContentCacheValue = nil;
      gShareableContentCacheAt = nil;
    }
  }
  [gShareableContentCacheLock unlock];
  return result;
}

static void StoreShareableContentCache(SCShareableContent *content) {
  if (!content) return;
  EnsureShareableContentCacheLock();
  [gShareableContentCacheLock lock];
  gShareableContentCacheValue = content;
  gShareableContentCacheAt = [NSDate date];
  [gShareableContentCacheLock unlock];
}

static void ClearShareableContentCache(void) {
  EnsureShareableContentCacheLock();
  [gShareableContentCacheLock lock];
  gShareableContentCacheValue = nil;
  gShareableContentCacheAt = nil;
  [gShareableContentCacheLock unlock];
}

static BOOL FetchShareableContentSync(SCShareableContent **outContent, NSError **outError) {
  __block SCShareableContent *result = nil;
  __block NSError *resultError = nil;
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

  [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                             onScreenWindowsOnly:NO
                                               completionHandler:^(SCShareableContent *shareableContent,
                                                                   NSError *shareableError) {
    result = shareableContent;
    resultError = shareableError;
    dispatch_semaphore_signal(semaphore);
  }];

  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  if (!result || resultError) {
    if (outError) {
      *outError = resultError ?: MakeError(2101, @"Could not list shareable screen content");
    }
    return NO;
  }
  if (outContent) *outContent = result;
  StoreShareableContentCache(result);
  return YES;
}

- (BOOL)getShareableContent:(SCShareableContent **)content error:(NSError **)error {
  return [self getShareableContent:content wasFromCache:NULL error:error];
}

- (BOOL)getShareableContent:(SCShareableContent **)content
                wasFromCache:(BOOL *)wasFromCache
                       error:(NSError **)error {
  SCShareableContent *cached = ReadShareableContentCache();
  if (cached) {
    if (content) *content = cached;
    if (wasFromCache) *wasFromCache = YES;
    return YES;
  }
  if (wasFromCache) *wasFromCache = NO;
  return FetchShareableContentSync(content, error);
}

+ (void)prewarmShareableContent {
  EnsureShareableContentCacheLock();
  [gShareableContentCacheLock lock];
  // Skip if we already have a fresh cache or an in-flight fetch will
  // populate it. The in-flight guard avoids piling up redundant SCKit
  // queries when the recorder bar + picker both call prewarm in quick
  // succession.
  BOOL fresh = NO;
  if (gShareableContentCacheValue && gShareableContentCacheAt) {
    NSTimeInterval age = -[gShareableContentCacheAt timeIntervalSinceNow];
    fresh = age >= 0 && age <= kShareableContentCacheTTL;
  }
  if (fresh || gShareableContentPrewarmInFlight) {
    [gShareableContentCacheLock unlock];
    return;
  }
  gShareableContentPrewarmInFlight = YES;
  [gShareableContentCacheLock unlock];

  [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                             onScreenWindowsOnly:NO
                                               completionHandler:^(SCShareableContent *shareableContent,
                                                                   NSError *shareableError) {
    EnsureShareableContentCacheLock();
    [gShareableContentCacheLock lock];
    gShareableContentPrewarmInFlight = NO;
    if (shareableContent && !shareableError) {
      gShareableContentCacheValue = shareableContent;
      gShareableContentCacheAt = [NSDate date];
    }
    [gShareableContentCacheLock unlock];
  }];
}

+ (void)invalidateShareableContentCache {
  ClearShareableContentCache();
}

- (SCDisplay *)displayFromContent:(SCShareableContent *)content {
  if (_options.target.displayId != 0) {
    for (SCDisplay *display in content.displays) {
      if (display.displayID == _options.target.displayId) {
        return display;
      }
    }
  }
  return [content.displays firstObject];
}

- (SCWindow *)windowFromContent:(SCShareableContent *)content {
  for (SCWindow *window in content.windows) {
    if (window.windowID == _options.target.windowId) {
      return window;
    }
  }
  return nil;
}

- (SCRunningApplication *)applicationFromContent:(SCShareableContent *)content {
  NSString *bundleId = ToNSString(_options.target.bundleId);
  for (SCRunningApplication *app in content.applications) {
    if ([app.bundleIdentifier isEqualToString:bundleId]) {
      return app;
    }
  }
  return nil;
}

- (NSArray<SCRunningApplication *> *)excludedOwnApps:(SCShareableContent *)content {
  if (!_options.excludeOwnApp) return @[];
  NSString *ownBundle = [[NSBundle mainBundle] bundleIdentifier];
  if (ownBundle.length == 0) return @[];

  NSMutableArray<SCRunningApplication *> *excluded = [NSMutableArray array];
  for (SCRunningApplication *app in content.applications) {
    if ([app.bundleIdentifier isEqualToString:ownBundle]) {
      [excluded addObject:app];
    }
  }
  return excluded;
}

- (SCContentFilter *)contentFilterFromContent:(SCShareableContent *)content
                                        error:(NSError **)error {
  if (_options.target.type == "window") {
    SCWindow *window = [self windowFromContent:content];
    if (!window) {
      if (error) *error = MakeError(2201, @"Requested window was not found");
      return nil;
    }
    return [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
  }

  SCDisplay *display = [self displayFromContent:content];
  if (!display) {
    if (error) *error = MakeError(2202, @"No display is available to capture");
    return nil;
  }

  if (_options.target.type == "application") {
    SCRunningApplication *app = [self applicationFromContent:content];
    if (!app) {
      if (error) *error = MakeError(2203, @"Requested application was not found");
      return nil;
    }
    return [[SCContentFilter alloc] initWithDisplay:display
                              includingApplications:@[ app ]
                                   exceptingWindows:@[]];
  }

  NSArray<SCRunningApplication *> *excludedApps = [self excludedOwnApps:content];
  if (excludedApps.count > 0) {
    return [[SCContentFilter alloc] initWithDisplay:display
                             excludingApplications:excludedApps
                                  exceptingWindows:@[]];
  }
  return [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
}

- (NSScreen *)screenForDisplayID:(CGDirectDisplayID)displayID {
  for (NSScreen *screen in [NSScreen screens]) {
    NSNumber *screenID = screen.deviceDescription[@"NSScreenNumber"];
    if (screenID && screenID.unsignedIntValue == displayID) {
      return screen;
    }
  }
  return nil;
}

- (BOOL)resolveDisplayPixelsForDisplay:(SCDisplay *)display
                                 width:(NSInteger *)outWidth
                                height:(NSInteger *)outHeight
                                 scale:(CGFloat *)outScale
                                source:(NSString **)outSource {
  if (!display) return NO;

  CGDirectDisplayID displayID = display.displayID;
  NSScreen *screen = [self screenForDisplayID:displayID];
  CGFloat scale = screen ? screen.backingScaleFactor : 2.0;

  CGDisplayModeRef mode = CGDisplayCopyDisplayMode(displayID);
  size_t modeWidth = mode ? CGDisplayModeGetPixelWidth(mode) : 0;
  size_t modeHeight = mode ? CGDisplayModeGetPixelHeight(mode) : 0;
  if (mode) CGDisplayModeRelease(mode);

  if (modeWidth > 0 && modeHeight > 0) {
    *outWidth = (NSInteger)modeWidth;
    *outHeight = (NSInteger)modeHeight;
    if (outScale) *outScale = scale;
    if (outSource) *outSource = @"CGDisplayModeGetPixelWidth";
    return YES;
  }

  if (screen) {
    NSRect framePoints = screen.frame;
    *outWidth = (NSInteger)llround(framePoints.size.width * scale);
    *outHeight = (NSInteger)llround(framePoints.size.height * scale);
    if (outScale) *outScale = scale;
    if (outSource) *outSource = @"NSScreen.frame * backingScaleFactor";
    return YES;
  }

  *outWidth = (NSInteger)display.width;
  *outHeight = (NSInteger)display.height;
  if (outScale) *outScale = scale;
  if (outSource) *outSource = @"SCDisplay";
  return YES;
}

- (CGRect)regionSourceRectForDisplay:(SCDisplay *)display scale:(CGFloat)scale {
  double sourceWidth = _options.target.sourceWidth > 0
      ? _options.target.sourceWidth
      : _options.target.width;
  double sourceHeight = _options.target.sourceHeight > 0
      ? _options.target.sourceHeight
      : _options.target.height;
  double sourceX = _options.target.sourceX;
  double sourceY = _options.target.sourceY;

  if (_options.target.sourceWidth <= 0 || _options.target.sourceHeight <= 0) {
    CGRect displayBounds = display ? CGDisplayBounds(display.displayID) : CGRectZero;
    sourceX = _options.target.x - displayBounds.origin.x;
    sourceY = _options.target.y - displayBounds.origin.y;
  }

  CGRect rect = CGRectMake(sourceX, sourceY, sourceWidth, sourceHeight);
  if (rect.size.width <= 0 || rect.size.height <= 0) return CGRectZero;

  NSScreen *screen = display ? [self screenForDisplayID:display.displayID] : nil;
  CGFloat pointWidth = screen ? screen.frame.size.width : 0;
  CGFloat pointHeight = screen ? screen.frame.size.height : 0;
  if ((pointWidth <= 0 || pointHeight <= 0) && display) {
    CGFloat safeScale = scale > 0 ? scale : 1.0;
    pointWidth = display.width / safeScale;
    pointHeight = display.height / safeScale;
  }

  if (pointWidth > 0 && pointHeight > 0) {
    CGRect displayRect = CGRectMake(0, 0, pointWidth, pointHeight);
    CGRect clipped = CGRectIntersection(rect, displayRect);
    if (!CGRectIsNull(clipped) && clipped.size.width > 0 && clipped.size.height > 0) {
      rect = clipped;
    }
  }

  return rect;
}

- (SCStreamConfiguration *)streamConfigurationForContent:(SCShareableContent *)content {
  SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];

  int width = _options.width;
  int height = _options.height;
  CGFloat scale = 1.0;
  NSString *source = @"options";
  NSScreen *targetScreen = nil;
  BOOL isRegionCapture = _options.target.type == "region";
  BOOL isWindowCapture = _options.target.type == "window";
  BOOL logicalResolution = [_resolvedResolutionMode isEqualToString:@"logical"];

  if (isRegionCapture) {
    SCDisplay *display = [self displayFromContent:content];
    targetScreen = display ? [self screenForDisplayID:display.displayID] : nil;
    scale = _options.target.scaleFactor > 0
        ? _options.target.scaleFactor
        : (targetScreen ? targetScreen.backingScaleFactor : 1.0);
    CGRect sourceRect = [self regionSourceRectForDisplay:display scale:scale];
    if (sourceRect.size.width > 0 && sourceRect.size.height > 0) {
      configuration.sourceRect = sourceRect;
      _configuredSourceRect = sourceRect;
      _hasConfiguredSourceRect = YES;
      if (width <= 0 || height <= 0) {
        // Logical mode: bare source-rect points (1×); native: × pointPixelScale.
        CGFloat effectiveScale = logicalResolution ? 1.0 : scale;
        width = (int)EvenDimensionFromDouble(sourceRect.size.width * effectiveScale);
        height = (int)EvenDimensionFromDouble(sourceRect.size.height * effectiveScale);
        source = logicalResolution
            ? @"region.sourceRect (logical)"
            : @"region.sourceRect * scaleFactor";
      }
    }
  }

  if (width <= 0 || height <= 0) {
    if (isWindowCapture) {
      SCWindow *window = [self windowFromContent:content];
      targetScreen = [NSScreen mainScreen];
      scale = targetScreen ? targetScreen.backingScaleFactor : 2.0;
      CGFloat effectiveScale = logicalResolution ? 1.0 : scale;
      width = (int)MAX(640, llround(window.frame.size.width * effectiveScale));
      height = (int)MAX(360, llround(window.frame.size.height * effectiveScale));
      source = logicalResolution
          ? @"window.frame (logical)"
          : @"window.frame * backingScaleFactor";
    } else {
      SCDisplay *display = [self displayFromContent:content];
      targetScreen = display ? [self screenForDisplayID:display.displayID] : nil;
      if (logicalResolution) {
        // Logical points — use the SCDisplay's logical dimensions when
        // available, falling back to NSScreen.frame.
        NSInteger pointWidth = display ? (NSInteger)display.width : 0;
        NSInteger pointHeight = display ? (NSInteger)display.height : 0;
        if ((pointWidth <= 0 || pointHeight <= 0) && targetScreen) {
          pointWidth = (NSInteger)llround(targetScreen.frame.size.width);
          pointHeight = (NSInteger)llround(targetScreen.frame.size.height);
        }
        width = (int)MAX(640, pointWidth);
        height = (int)MAX(360, pointHeight);
        scale = targetScreen ? targetScreen.backingScaleFactor : 1.0;
        source = @"SCDisplay (logical)";
      } else {
        NSInteger pixelWidth = 0;
        NSInteger pixelHeight = 0;
        NSString *resolvedSource = nil;
        [self resolveDisplayPixelsForDisplay:display
                                       width:&pixelWidth
                                      height:&pixelHeight
                                       scale:&scale
                                      source:&resolvedSource];
        width = (int)MAX(640, pixelWidth);
        height = (int)MAX(360, pixelHeight);
        source = resolvedSource ?: @"unknown";
      }
    }
  }
  if (!targetScreen) targetScreen = [NSScreen mainScreen];

  // H.264 / HEVC hardware encoders reject odd dimensions.
  if (width % 2 != 0) width -= 1;
  if (height % 2 != 0) height -= 1;

  _configuredWidth = width;
  _configuredHeight = height;
  _configuredScaleFactor = scale;
  _pixelSizeSource = source;

  configuration.width = width;
  configuration.height = height;
  configuration.scalesToFit = isWindowCapture ? YES : NO;
  // preservesAspectRatio / ignore{Global,Shadows}SingleWindow are 14.0+;
  // includeChildWindows is 14.2+. Gate each behind its availability so the
  // addon stays buildable + runnable on macOS 13.
  if (@available(macOS 14.0, *)) {
    configuration.preservesAspectRatio = YES;
    if (isWindowCapture) {
      configuration.ignoreGlobalClipSingleWindow = YES;
      configuration.ignoreShadowsSingleWindow = YES;
    }
  }
  if (isWindowCapture) {
    if (@available(macOS 14.2, *)) {
      configuration.includeChildWindows = NO;
    }
  }
  // Frame rate: 0 → native (1/120 minimum interval); explicit values → 1/fps.
  int frameRate = _resolvedFrameRate;
  if (frameRate == 0) {
    configuration.minimumFrameInterval = CMTimeMake(1, 120);
  } else {
    configuration.minimumFrameInterval = CMTimeMake(1, frameRate);
  }
  // SCStreamConfiguration's default queueDepth is 8 — BetterCapture leaves
  // it alone. A smaller queue (we previously used 5) drops frames sooner
  // when the encoder lags, with no upside.
  configuration.queueDepth = 8;
  configuration.showsCursor = _options.includeCursor;
  configuration.backgroundColor = CGColorGetConstantColor(kCGColorBlack);

  // "Apple gold-standard" SDR pipeline:
  //   * pixelFormat = BGRA 8-bit.
  //   * captureDynamicRange = .SDR (macOS 15+; on 13/14 SCK is implicitly SDR).
  //   * colorSpaceName = kCGColorSpaceSRGB. ScreenCaptureKit performs a
  //     hardware-accelerated GPU color conversion when `colorSpaceName` is
  //     set, so on a Display-P3 screen it transforms the wide-gamut source
  //     pixels into sRGB *correctly* (perceptual gamut mapping) before
  //     delivering the buffer. Without this, SCKit hands AVAssetWriter a
  //     buffer in some untagged working space, AVAssetWriter then performs
  //     its own conversion to BT.709, and the resulting file looks
  //     washed-out compared to a `Cmd+Shift+3` screenshot of the same
  //     content. sRGB and BT.709 share primaries; with the writer tagged
  //     BT.709 (in -videoColorProperties) the only remaining transform is
  //     a small transfer-function adjustment (sRGB piecewise ≈ BT.709
  //     gamma 2.4) that AVAssetWriter handles cleanly. The OBS team hit
  //     the same gotcha (obsproject/obs-studio#12414, #9658).
  configuration.pixelFormat = kSDRPixelFormat;
  configuration.colorSpaceName = kCGColorSpaceSRGB;
  if (@available(macOS 15.0, *)) {
    configuration.captureDynamicRange = SCCaptureDynamicRangeSDR;
  }
  (void)targetScreen;  // No longer used for gamut detection.
  _configuredColorSpace = @"sRGB";
  _configuredColorPrimaries = AVVideoColorPrimaries_ITU_R_709_2;
  _configuredGamut = @"Rec.709";

  // Compute compression properties up front so the bitrate / keyframe
  // values show up in the startup log alongside the rest of the config.
  // -prepareWriter: will read them later via -videoCompressionProperties.
  (void)[self videoCompressionProperties];

  // Per-application audio scoping. The list lives on RecordingOptions and is
  // populated by the renderer when the user opts into "Record sound from this
  // application only". On macOS 13-14, the surrounding SCContentFilter
  // (initWithDesktopIndependentWindow: in window mode) already constrains
  // audio to the owning app — Apple's WWDC22 session 10155 documents that
  // audio capture is app-granular regardless of window-level filtering. The
  // explicit applicationsToInclude assignment below sharpens that scope on
  // macOS 15+ and prepares the path for display/region modes where the
  // window filter doesn't help. KVC + respondsToSelector keeps the call safe
  // if the SDK predates the property — when missing, the window filter's
  // implicit scoping remains the effective enforcement.
  if (@available(macOS 15.0, *)) {
    if (!_options.audioApplicationBundleIds.empty() &&
        [configuration respondsToSelector:@selector(setApplicationsToInclude:)]) {
      NSMutableArray<SCRunningApplication *> *apps = [NSMutableArray array];
      for (const std::string &bid : _options.audioApplicationBundleIds) {
        NSString *targetBundle = ToNSString(bid);
        if (targetBundle.length == 0) continue;
        for (SCRunningApplication *app in content.applications) {
          if ([app.bundleIdentifier isEqualToString:targetBundle]) {
            [apps addObject:app];
            break;
          }
        }
      }
      // Always assign when the user opted into per-app scoping, even if no
      // running app matched the requested bundle IDs. An empty array means
      // "capture from none of the listed apps" — without this, an empty
      // match list would leave applicationsToInclude unset, silently
      // falling back to the implicit filter scope (window's owning app, or
      // all apps in display/region mode) — i.e. recording audio the user
      // explicitly excluded.
      [configuration setValue:apps forKey:@"applicationsToInclude"];
    }
  }

  int loggedFps = (_resolvedFrameRate == 0) ? 120 : _resolvedFrameRate;
  NSLog(@"[openscreen.recorder] screen config: %ldx%ld @ %dfps (mode=%@)  "
        @"codec=%@  container=%@  quality=%@  "
        @"pixelFormat=BGRA  colorSpace=%@  primaries=%@ (gamut=%@)  "
        @"bitrate=%.1f Mbps  keyframeInterval=%ldf  scale=%.2fx  "
        @"pixelSizeSource=%@  scalesToFit=%@  queueDepth=8  "
        @"allowFrameReordering=YES  audioApps=%lu",
        (long)_configuredWidth, (long)_configuredHeight,
        loggedFps,
        (_resolvedFrameRate == 0 ? @"native (1/120)" : @"explicit"),
        [self codecString], _resolvedContainer,
        _resolvedQuality,
        _configuredColorSpace,
        _configuredColorPrimaries, _configuredGamut,
        _configuredBitRate / 1'000'000.0,
        (long)_configuredKeyframeInterval,
        _configuredScaleFactor, _pixelSizeSource,
        configuration.scalesToFit ? @"YES" : @"NO",
        (unsigned long)_options.audioApplicationBundleIds.size());

  return configuration;
}

#pragma mark - AVAssetWriter

- (NSDictionary *)videoColorProperties {
  // Universal SDR colorimetry — BT.709 primaries / transfer / matrix. Works
  // on every macOS / iOS / web player. Wide-gamut input is perceptually
  // mapped to BT.709 on the SCK capture side (see
  // -streamConfigurationForContent: where colorSpaceName = sRGB), so the
  // file's tag accurately describes its content.
  return @{
    AVVideoColorPrimariesKey:   AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey:      AVVideoYCbCrMatrix_ITU_R_709_2,
  };
}

- (NSDictionary *)videoCompressionProperties {
  // Bitrate uses BetterCapture's bits-per-pixel table:
  //
  //   Low    H.264 0.04   HEVC 0.02
  //   Medium H.264 0.20   HEVC 0.15
  //   High   H.264 0.60   HEVC 0.40    (default — matches BetterCapture "High")
  //
  // Formula: bitrate = width × height × fps × bpp. HEVC needs roughly half
  // the rate of H.264 for the same perceived quality. No floor.
  int fps = _resolvedFrameRate == 0 ? 60 : _resolvedFrameRate;
  if (fps <= 0) fps = 60;
  double bpp = _resolvedBitsPerPixel > 0 ? _resolvedBitsPerPixel : 0.40;
  NSInteger bitRate = (NSInteger)(_configuredWidth * _configuredHeight * fps * bpp);

  // Keyframe every ~2 seconds — matches BetterCapture; recent keyframe to
  // seek to without inflating file size.
  NSInteger maxKeyframeInterval = fps * 2;

  _configuredBitRate = bitRate;
  _configuredKeyframeInterval = maxKeyframeInterval;

  // No profile-level key — VideoToolbox picks HEVC Main 8-bit / H.264 High
  // AutoLevel by default, matching BetterCapture's SDR output.
  // B-frames intentionally left at VideoToolbox default (enabled).
  return @{
    AVVideoAverageBitRateKey:           @(bitRate),
    AVVideoMaxKeyFrameIntervalKey:      @(maxKeyframeInterval),
    AVVideoExpectedSourceFrameRateKey:  @(fps),
  };
}

- (BOOL)prepareWriter:(NSError **)error {
  if (_writer) return YES;
  if (!_url) {
    if (error) *error = MakeError(2301, @"Screen track output URL is not set");
    return NO;
  }
  if (_configuredWidth <= 0 || _configuredHeight <= 0) {
    if (error) *error = MakeError(2302, @"Screen track dimensions not yet resolved");
    return NO;
  }

  NSError *writerError = nil;
  AVFileType fileType = FileTypeForContainer(_resolvedContainer);
  _writer = [[AVAssetWriter alloc] initWithURL:_url
                                      fileType:fileType
                                         error:&writerError];
  if (!_writer || writerError) {
    if (error) *error = writerError ?: MakeError(2303, @"Could not create AVAssetWriter");
    _writer = nil;
    return NO;
  }

  // Video output settings — both codecs we expose (HEVC, H.264) take both
  // the color and compression dictionaries.
  NSMutableDictionary *videoSettings = [NSMutableDictionary dictionary];
  videoSettings[AVVideoCodecKey] = _codec;
  videoSettings[AVVideoWidthKey] = @(_configuredWidth);
  videoSettings[AVVideoHeightKey] = @(_configuredHeight);
  NSDictionary *colorProps = [self videoColorProperties];
  if (colorProps) videoSettings[AVVideoColorPropertiesKey] = colorProps;
  NSDictionary *compressionProps = [self videoCompressionProperties];
  if (compressionProps) videoSettings[AVVideoCompressionPropertiesKey] = compressionProps;

  _videoInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeVideo
                                               outputSettings:videoSettings];
  _videoInput.expectsMediaDataInRealTime = YES;
  if (![_writer canAddInput:_videoInput]) {
    if (error) *error = MakeError(2304, @"AVAssetWriter rejected the video input");
    _writer = nil;
    _videoInput = nil;
    return NO;
  }
  [_writer addInput:_videoInput];
  return YES;
}

- (NSDictionary *)audioOutputSettings {
  // 48 kHz stereo AAC at 256 kbps. Matches BetterCapture exactly — same
  // codec, same sample rate, same channel count, same bitrate, and no
  // explicit AVChannelLayoutKey (AVAssetWriter derives the layout from the
  // number of channels). Previously we set 192 kbps + an explicit stereo
  // layout dict; both produce technically-valid AAC, but 256 kbps gives a
  // noticeably cleaner system-audio track, especially for music.
  return @{
    AVFormatIDKey:         @(kAudioFormatMPEG4AAC),
    AVSampleRateKey:       @48000,
    AVNumberOfChannelsKey: @2,
    AVEncoderBitRateKey:   @256000,
  };
}

- (BOOL)addSystemAudioInput:(NSError **)error {
  if (!_writer) {
    if (error) *error = MakeError(2305, @"Writer not prepared before addSystemAudioInput");
    return NO;
  }
  if (_systemAudioInput) return YES;
  _systemAudioInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio
                                                     outputSettings:[self audioOutputSettings]];
  _systemAudioInput.expectsMediaDataInRealTime = YES;
  if (![_writer canAddInput:_systemAudioInput]) {
    if (error) *error = MakeError(2306, @"AVAssetWriter rejected the system-audio input");
    _systemAudioInput = nil;
    return NO;
  }
  [_writer addInput:_systemAudioInput];
  return YES;
}

- (BOOL)addMicrophoneInput:(NSError **)error {
  if (!_writer) {
    if (error) *error = MakeError(2307, @"Writer not prepared before addMicrophoneInput");
    return NO;
  }
  if (_microphoneInput) return YES;
  _microphoneInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio
                                                    outputSettings:[self audioOutputSettings]];
  _microphoneInput.expectsMediaDataInRealTime = YES;
  if (![_writer canAddInput:_microphoneInput]) {
    if (error) *error = MakeError(2308, @"AVAssetWriter rejected the microphone input");
    _microphoneInput = nil;
    return NO;
  }
  [_writer addInput:_microphoneInput];
  return YES;
}

- (BOOL)hasSystemAudioInput { return _systemAudioInput != nil; }
- (BOOL)hasMicrophoneInput  { return _microphoneInput != nil; }

#pragma mark - SCStreamOutput

- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error {
  NSError *addOutputError = nil;
  if (![stream addStreamOutput:self
                          type:SCStreamOutputTypeScreen
            sampleHandlerQueue:_videoQueue
                         error:&addOutputError]) {
    if (error) *error = addOutputError ?: MakeError(2501, @"Could not add screen stream output");
    return NO;
  }
  return YES;
}

- (NSDictionary *)frameAttachments:(CMSampleBufferRef)sampleBuffer {
  CFArrayRef attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (!attachmentsArray || CFArrayGetCount(attachmentsArray) == 0) return nil;
  return (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachmentsArray, 0);
}

- (void)recordFrameMetadata:(NSDictionary *)attachments {
  if (!attachments) {
    _unknownFrameCount++;
    return;
  }

  NSNumber *statusNumber = attachments[SCStreamFrameInfoStatus];
  if (!statusNumber) {
    _unknownFrameCount++;
  } else {
    SCFrameStatus status = (SCFrameStatus)[statusNumber integerValue];
    switch (status) {
      case SCFrameStatusComplete:
        _completeFrameCount++;
        break;
      case SCFrameStatusIdle:
        _idleFrameCount++;
        break;
      case SCFrameStatusBlank:
        _blankFrameCount++;
        break;
      case SCFrameStatusSuspended:
        _suspendedFrameCount++;
        break;
      case SCFrameStatusStarted:
        _startedFrameCount++;
        break;
      case SCFrameStatusStopped:
        _stoppedFrameCount++;
        break;
      default:
        _unknownFrameCount++;
        break;
    }
  }

  NSNumber *contentScale = attachments[SCStreamFrameInfoContentScale];
  if (contentScale) _lastContentScale = contentScale.doubleValue;

  NSNumber *scaleFactor = attachments[SCStreamFrameInfoScaleFactor];
  if (scaleFactor) _lastFrameScaleFactor = scaleFactor.doubleValue;

  CGRect rect = CGRectZero;
  if (CGRectFromFrameAttachment(attachments[SCStreamFrameInfoContentRect], &rect)) {
    _lastContentRect = rect;
    _hasLastContentRect = YES;
  }
  if (@available(macOS 13.1, *)) {
    if (CGRectFromFrameAttachment(attachments[SCStreamFrameInfoScreenRect], &rect)) {
      _lastScreenRect = rect;
      _hasLastScreenRect = YES;
    }
  }
  if (@available(macOS 14.0, *)) {
    if (CGRectFromFrameAttachment(attachments[SCStreamFrameInfoBoundingRect], &rect)) {
      _lastBoundingRect = rect;
      _hasLastBoundingRect = YES;
    }
  }

  NSArray *dirtyRects = attachments[SCStreamFrameInfoDirtyRects];
  if ([dirtyRects isKindOfClass:[NSArray class]] && dirtyRects.count > 0) {
    _dirtyFrameCount++;
    _dirtyRectCount += dirtyRects.count;
    if ((NSInteger)dirtyRects.count > _maxDirtyRectsInFrame) {
      _maxDirtyRectsInFrame = dirtyRects.count;
    }
  }
}

- (BOOL)isCompleteScreenFrameFromAttachments:(NSDictionary *)attachments {
  if (!attachments) return NO;
  NSNumber *statusNumber = attachments[SCStreamFrameInfoStatus];
  if (!statusNumber) return NO;
  return (SCFrameStatus)[statusNumber integerValue] == SCFrameStatusComplete;
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  if (_stopping.load(std::memory_order_acquire) || !CMSampleBufferIsValid(sampleBuffer)) return;
  if (type != SCStreamOutputTypeScreen) return;
  NSDictionary *attachments = [self frameAttachments:sampleBuffer];
  [self recordFrameMetadata:attachments];
  if (![self isCompleteScreenFrameFromAttachments:attachments]) return;
  [self appendVideoSampleBuffer:sampleBuffer];
}

#pragma mark - Append helpers (called from SCStreamOutput delegates)

- (BOOL)ensureSessionStartedWithPTS:(CMTime)pts {
  [_writerLock lock];
  if (_writerFailed) {
    [_writerLock unlock];
    return NO;
  }
  if (!_sessionStarted) {
    if (_writer.status == AVAssetWriterStatusUnknown) {
      if (![_writer startWriting]) {
        _writerFailed = YES;
        EmitEvent({"error", ToStdString(_sessionId), "screen",
                   ToStdString(_writer.error.localizedDescription ?: @"startWriting failed"), 0});
        [_writerLock unlock];
        return NO;
      }
    }
    if (_writer.status != AVAssetWriterStatusWriting) {
      _writerFailed = YES;
      [_writerLock unlock];
      return NO;
    }
    [_writer startSessionAtSourceTime:pts];
    _sessionStartTime = pts;
    _sessionStarted = YES;
    _started = YES;
    EmitEvent({"fileStarted", ToStdString(_sessionId), "screen",
               ToStdString([_url path] ?: @""), 0});
  }
  [_writerLock unlock];
  return YES;
}

// Returns NO + drop if currently paused. Otherwise writes the active pause
// shift to *outShift so callers can adjust PTS / build a shifted sample
// buffer. _writerLock guards both flags.
- (BOOL)gateSampleAppend:(CMTime *)outShift {
  [_writerLock lock];
  if (_writerFailed) { [_writerLock unlock]; return NO; }
  if (_paused)       { [_writerLock unlock]; return NO; }
  if (outShift) *outShift = _pauseAccumulated;
  [_writerLock unlock];
  return YES;
}

// Build a copy of `original` with PTS/DTS shifted backwards by `shift`. The
// returned buffer must be CFReleased by the caller. Returns NULL on failure
// or when `shift` is zero (the caller should reuse `original` in that case).
static CMSampleBufferRef ScreenTrackShiftedSampleBuffer(
    CMSampleBufferRef original, CMTime shift) {
  if (CMTimeCompare(shift, kCMTimeZero) == 0) return NULL;
  CMItemCount entries = 0;
  if (CMSampleBufferGetSampleTimingInfoArray(original, 0, NULL, &entries) != noErr ||
      entries == 0) {
    return NULL;
  }
  CMSampleTimingInfo stackTiming[16];
  CMSampleTimingInfo *timing = stackTiming;
  std::vector<CMSampleTimingInfo> heap;
  if (entries > 16) {
    heap.resize(entries);
    timing = heap.data();
  }
  if (CMSampleBufferGetSampleTimingInfoArray(original, entries, timing, &entries) != noErr) {
    return NULL;
  }
  for (CMItemCount i = 0; i < entries; ++i) {
    if (CMTIME_IS_VALID(timing[i].presentationTimeStamp)) {
      timing[i].presentationTimeStamp =
          CMTimeSubtract(timing[i].presentationTimeStamp, shift);
    }
    if (CMTIME_IS_VALID(timing[i].decodeTimeStamp)) {
      timing[i].decodeTimeStamp = CMTimeSubtract(timing[i].decodeTimeStamp, shift);
    }
  }
  CMSampleBufferRef shifted = NULL;
  OSStatus status = CMSampleBufferCreateCopyWithNewTiming(
      kCFAllocatorDefault, original, entries, timing, &shifted);
  if (status != noErr) {
    if (shifted) CFRelease(shifted);
    return NULL;
  }
  return shifted;
}

- (void)appendVideoSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (!_videoInput) return;
  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (CMTIME_IS_INVALID(pts)) return;

  CMTime shift = kCMTimeZero;
  if (![self gateSampleAppend:&shift]) {
    _videoSamplesDropped++;
    return;
  }

  CMSampleBufferRef shifted = ScreenTrackShiftedSampleBuffer(sampleBuffer, shift);
  CMSampleBufferRef target = shifted ?: sampleBuffer;
  CMTime adjustedPts = (shifted != NULL) ? CMTimeSubtract(pts, shift) : pts;

  if (![self ensureSessionStartedWithPTS:adjustedPts]) {
    if (shifted) CFRelease(shifted);
    return;
  }
  if (_videoInput.readyForMoreMediaData) {
    if ([_videoInput appendSampleBuffer:target]) {
      _videoSamplesAppended++;
    } else {
      _videoSamplesDropped++;
    }
  } else {
    _videoSamplesDropped++;
    if (!_videoBackpressureEventSent) {
      _videoBackpressureEventSent = YES;
      EmitEvent({"backpressure", ToStdString(_sessionId), "screen",
                 "Video writer is not ready for more frame data", 0});
    }
  }
  if (shifted) CFRelease(shifted);
}

- (void)appendAudioSampleBuffer:(CMSampleBufferRef)sampleBuffer
                        toInput:(AVAssetWriterInput *)input
                  droppedBefore:(NSInteger *)droppedBeforeStart {
  if (!input) return;
  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (CMTIME_IS_INVALID(pts)) return;

  CMTime shift = kCMTimeZero;
  if (![self gateSampleAppend:&shift]) return;

  // Audio samples that arrive before the first video frame are dropped — the
  // session must start at a video PTS to keep the .mov starting with a
  // displayable frame.
  if (!_sessionStarted) {
    if (droppedBeforeStart) (*droppedBeforeStart)++;
    return;
  }

  CMSampleBufferRef shifted = ScreenTrackShiftedSampleBuffer(sampleBuffer, shift);
  CMSampleBufferRef target = shifted ?: sampleBuffer;

  if (input.readyForMoreMediaData) {
    [input appendSampleBuffer:target];
  }
  if (shifted) CFRelease(shifted);
}

- (void)appendSystemAudioSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_stopping.load(std::memory_order_acquire) || !CMSampleBufferIsValid(sampleBuffer)) return;
  [self appendAudioSampleBuffer:sampleBuffer
                        toInput:_systemAudioInput
                  droppedBefore:&_droppedSystemAudioBeforeStart];
}

- (void)appendMicrophoneSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_stopping.load(std::memory_order_acquire) || !CMSampleBufferIsValid(sampleBuffer)) return;
  [self appendAudioSampleBuffer:sampleBuffer
                        toInput:_microphoneInput
                  droppedBefore:&_droppedMicrophoneBeforeStart];
}

#pragma mark - Lifecycle

- (void)markStopping {
  // Release-store pairs with the acquire-loads in the SCKit sample-handler
  // path so once -markAsFinished runs in -finishWriterSync, no in-flight
  // sample on _videoQueue / SCKit threads can read stale `false` and try to
  // append to a finished input.
  _stopping.store(true, std::memory_order_release);
}

- (void)setPaused:(BOOL)paused {
  [_writerLock lock];
  if (_paused == paused) {
    [_writerLock unlock];
    return;
  }
  if (paused) {
    _pauseStartHost = CMClockGetTime(CMClockGetHostTimeClock());
    _paused = YES;
  } else {
    if (CMTIME_IS_VALID(_pauseStartHost)) {
      CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
      CMTime delta = CMTimeSubtract(now, _pauseStartHost);
      if (CMTimeCompare(delta, kCMTimeZero) > 0) {
        _pauseAccumulated = CMTimeAdd(_pauseAccumulated, delta);
      }
    }
    _pauseStartHost = kCMTimeInvalid;
    _paused = NO;
    _pauseCycleCount += 1;
  }
  [_writerLock unlock];
}

- (BOOL)isPaused {
  [_writerLock lock];
  BOOL value = _paused;
  [_writerLock unlock];
  return value;
}

- (CMTime)pauseAccumulated {
  [_writerLock lock];
  CMTime value = _pauseAccumulated;
  // If we're paused right now, fold the in-flight pause into the reported
  // total so the manifest / UI sees a monotonically growing duration.
  if (_paused && CMTIME_IS_VALID(_pauseStartHost)) {
    CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
    CMTime delta = CMTimeSubtract(now, _pauseStartHost);
    if (CMTimeCompare(delta, kCMTimeZero) > 0) {
      value = CMTimeAdd(value, delta);
    }
  }
  [_writerLock unlock];
  return value;
}

- (BOOL)finishWriterSync:(NSError **)error {
  if (!_writer) return YES;
  if (_writer.status == AVAssetWriterStatusCancelled) {
    _writer = nil;
    _videoInput = nil;
    _systemAudioInput = nil;
    _microphoneInput = nil;
    return YES;
  }
  if (_writer.status == AVAssetWriterStatusUnknown) {
    // Never appended a sample.
    [_writer cancelWriting];
    _writer = nil;
    _videoInput = nil;
    _systemAudioInput = nil;
    _microphoneInput = nil;
    return YES;
  }

  [_videoInput markAsFinished];
  [_systemAudioInput markAsFinished];
  [_microphoneInput markAsFinished];

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [_writer finishWritingWithCompletionHandler:^{
    dispatch_semaphore_signal(semaphore);
  }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

  _finished = YES;
  BOOL ok = YES;
  NSError *finishError = nil;
  if (_writer.status == AVAssetWriterStatusFailed) {
    finishError = _writer.error ?: MakeError(2310, @"AVAssetWriter finished with failure");
    ok = NO;
  }
  // Cache the failure reason before releasing the writer so -metadata still
  // reports it in the manifest (writeManifest runs after finishWriterSync).
  // Prefer finishError (which carries the MakeError fallback for the rare
  // case of status==Failed with a nil _writer.error).
  _savedWriterError = finishError ?: _writer.error;
  _writer = nil;
  _videoInput = nil;
  _systemAudioInput = nil;
  _microphoneInput = nil;
  if (!ok && error) *error = finishError;
  return ok;
}

- (void)cancelWriter {
  if (!_writer) return;
  if (_writer.status == AVAssetWriterStatusWriting) {
    [_writer cancelWriting];
  }
  _writer = nil;
  _videoInput = nil;
  _systemAudioInput = nil;
  _microphoneInput = nil;
}

#pragma mark - Manifest

- (NSURL *)url        { return _url; }
- (BOOL)hasWriter     { return _writer != nil; }
- (BOOL)hasStarted    { return _started; }

- (NSString *)codecString {
  if ([_codec isEqualToString:AVVideoCodecTypeHEVC]) return @"hevc";
  if ([_codec isEqualToString:AVVideoCodecTypeH264]) return @"h264";
  return _codec ?: @"";
}

- (NSDictionary *)metadata {
  NSMutableDictionary *meta = [NSMutableDictionary dictionary];
  meta[@"source"] = @"screen";
  meta[@"path"] = [_url path] ?: @"";
  meta[@"started"] = @(_started);
  meta[@"finished"] = @(_finished);
  meta[@"codec"] = [self codecString];
  // Resolved configuration. Each field reflects the *coerced* value the
  // writer used, not the user's original request.
  if (_resolvedCodecKey) meta[@"videoCodec"] = _resolvedCodecKey;
  if (_resolvedQuality) meta[@"videoQuality"] = _resolvedQuality;
  if (_resolvedContainer) meta[@"container"] = _resolvedContainer;
  if (_resolvedResolutionMode) meta[@"resolutionMode"] = _resolvedResolutionMode;
  meta[@"frameRate"] = @(_resolvedFrameRate);
  if (_resolvedBitsPerPixel > 0) meta[@"bitsPerPixel"] = @(_resolvedBitsPerPixel);
  meta[@"pixelFormat"] = @"BGRA";
  // Universal SDR colorimetry — BT.709 throughout.
  meta[@"colorPrimaries"] = @"ITU_R_709_2";
  meta[@"colorTransfer"] = @"ITU_R_709_2";
  meta[@"colorMatrix"] = @"ITU_R_709_2";
  if (_configuredGamut) meta[@"gamut"] = _configuredGamut;
  if (_configuredBitRate > 0) meta[@"averageBitRate"] = @(_configuredBitRate);
  if (_configuredKeyframeInterval > 0) {
    meta[@"maxKeyFrameInterval"] = @(_configuredKeyframeInterval);
  }
  // BetterCapture-aligned defaults: B-frames enabled (VT default), queueDepth
  // at SCK's default of 8.
  meta[@"allowFrameReordering"] = @YES;
  meta[@"queueDepth"] = @8;
  if (_pauseCycleCount > 0) meta[@"pauseCycles"] = @(_pauseCycleCount);
  CMTime totalPaused = [self pauseAccumulated];
  if (CMTimeCompare(totalPaused, kCMTimeZero) > 0) {
    meta[@"pausedMs"] = @(TimeToMilliseconds(totalPaused));
  }
  if (_configuredWidth > 0) meta[@"width"] = @(_configuredWidth);
  if (_configuredHeight > 0) meta[@"height"] = @(_configuredHeight);
  if (_configuredScaleFactor > 0) meta[@"scaleFactor"] = @(_configuredScaleFactor);
  if (_hasConfiguredSourceRect) {
    meta[@"sourceRect"] = DictionaryFromCGRect(_configuredSourceRect);
  }
  if (_pixelSizeSource) meta[@"pixelSizeSource"] = _pixelSizeSource;
  if (_configuredColorSpace) meta[@"colorSpace"] = _configuredColorSpace;
  meta[@"videoSamples"] = @(_videoSamplesAppended);
  meta[@"droppedVideoSamples"] = @(_videoSamplesDropped);
  meta[@"completeFrames"] = @(_completeFrameCount);
  meta[@"idleFrames"] = @(_idleFrameCount);
  meta[@"blankFrames"] = @(_blankFrameCount);
  meta[@"suspendedFrames"] = @(_suspendedFrameCount);
  meta[@"startedFrames"] = @(_startedFrameCount);
  meta[@"stoppedFrames"] = @(_stoppedFrameCount);
  meta[@"unknownFrames"] = @(_unknownFrameCount);
  meta[@"dirtyFrames"] = @(_dirtyFrameCount);
  meta[@"dirtyRects"] = @(_dirtyRectCount);
  meta[@"maxDirtyRectsInFrame"] = @(_maxDirtyRectsInFrame);
  if (_lastContentScale > 0) meta[@"lastContentScale"] = @(_lastContentScale);
  if (_lastFrameScaleFactor > 0) meta[@"lastFrameScaleFactor"] = @(_lastFrameScaleFactor);
  if (_hasLastContentRect) meta[@"lastContentRect"] = DictionaryFromCGRect(_lastContentRect);
  if (_hasLastBoundingRect) meta[@"lastBoundingRect"] = DictionaryFromCGRect(_lastBoundingRect);
  if (_hasLastScreenRect) meta[@"lastScreenRect"] = DictionaryFromCGRect(_lastScreenRect);
  if (_droppedSystemAudioBeforeStart > 0) {
    meta[@"droppedSystemAudioBeforeStart"] = @(_droppedSystemAudioBeforeStart);
  }
  if (_droppedMicrophoneBeforeStart > 0) {
    meta[@"droppedMicrophoneBeforeStart"] = @(_droppedMicrophoneBeforeStart);
  }
  // Prefer the live writer's error; fall back to the cached value captured by
  // -finishWriterSync when the writer ivar has already been released.
  NSError *writerError = _writer.error ?: _savedWriterError;
  if (writerError) {
    meta[@"error"] = writerError.localizedDescription ?: @"";
  }
  return meta;
}

@end
