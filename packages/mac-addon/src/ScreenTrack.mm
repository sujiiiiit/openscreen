#include "ScreenTrack.h"

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>

#include <sys/sysctl.h>

#include <vector>

#include "Events.h"

// Match OBS: 10-bit packed RGB (`l10r` = kCVPixelFormatType_ARGB2101010LEPacked).
// Capturing in 10-bit avoids the precision loss of 8-bit YCbCr 4:2:0 — text
// edges and saturated colours stay sharp through to the encoder.
static const OSType kPixelFormat = kCVPixelFormatType_ARGB2101010LEPacked;

static AVVideoCodecType PreferredScreenCodec() {
  int isAppleSilicon = 0;
  size_t size = sizeof(isAppleSilicon);
  if (sysctlbyname("hw.optional.arm64", &isAppleSilicon, &size, NULL, 0) == 0 &&
      isAppleSilicon == 1) {
    return AVVideoCodecTypeHEVC;
  }
  return AVVideoCodecTypeH264;
}

static NSString *ProfileLevelForCodec(AVVideoCodecType codec) {
  if ([codec isEqualToString:AVVideoCodecTypeHEVC]) {
    // HEVC Main10 — required to preserve the 10-bit precision we capture in.
    // HEVC profile/level constants live in VideoToolbox per AVVideoSettings.h
    // ("HEVC profiles/levels are defined in VideoToolbox/VTCompressionProperties.h,
    // e.g. kVTProfileLevel_HEVC_Main_AutoLevel. The constants defined there
    // can be used as the value for the key AVVideoProfileLevelKey.").
    return (__bridge NSString *)kVTProfileLevel_HEVC_Main10_AutoLevel;
  }
  return AVVideoProfileLevelH264HighAutoLevel;
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
  AVVideoCodecType _codec;

  dispatch_queue_t _videoQueue;
  // Single lock around session-start + AVAssetWriter status checks. Individual
  // -appendSampleBuffer: calls on a given AVAssetWriterInput are thread-safe
  // on their own.
  NSLock *_writerLock;
  BOOL _sessionStarted;
  CMTime _sessionStartTime;
  BOOL _writerFailed;

  BOOL _stopping;
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
  }
  return self;
}

- (void)setOutputURL:(NSURL *)url {
  _url = url;
}

#pragma mark - SCKit setup

- (BOOL)getShareableContent:(SCShareableContent **)content error:(NSError **)error {
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
    if (error) {
      *error = resultError ?: MakeError(2101, @"Could not list shareable screen content");
    }
    return NO;
  }

  *content = result;
  return YES;
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
        width = (int)EvenDimensionFromDouble(sourceRect.size.width * scale);
        height = (int)EvenDimensionFromDouble(sourceRect.size.height * scale);
        source = @"region.sourceRect * scaleFactor";
      }
    }
  }

  if (width <= 0 || height <= 0) {
    if (isWindowCapture) {
      SCWindow *window = [self windowFromContent:content];
      targetScreen = [NSScreen mainScreen];
      scale = targetScreen ? targetScreen.backingScaleFactor : 2.0;
      width = (int)MAX(640, llround(window.frame.size.width * scale));
      height = (int)MAX(360, llround(window.frame.size.height * scale));
      source = @"window.frame * backingScaleFactor";
    } else {
      SCDisplay *display = [self displayFromContent:content];
      targetScreen = display ? [self screenForDisplayID:display.displayID] : nil;
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
  if (!targetScreen) targetScreen = [NSScreen mainScreen];

  // HEVC / H.264 hardware encoders reject odd dimensions.
  if (width % 2 != 0) width -= 1;
  if (height % 2 != 0) height -= 1;

  _configuredWidth = width;
  _configuredHeight = height;
  _configuredScaleFactor = scale;
  _pixelSizeSource = source;
  _codec = PreferredScreenCodec();

  configuration.width = width;
  configuration.height = height;
  configuration.scalesToFit = isWindowCapture ? YES : NO;
  configuration.preservesAspectRatio = YES;
  if (isWindowCapture) {
    configuration.ignoreGlobalClipSingleWindow = YES;
    configuration.ignoreShadowsSingleWindow = YES;
    configuration.includeChildWindows = NO;
  }
  configuration.minimumFrameInterval = CMTimeMake(1, _options.fps > 0 ? _options.fps : 60);
  configuration.queueDepth = 5;
  configuration.showsCursor = _options.includeCursor;
  // 10-bit packed RGB — same as OBS uses ([mac-sck-video-capture.m]). Carries
  // the full Display-P3 gamut with no chroma subsampling between capture and
  // encoder.
  configuration.pixelFormat = kPixelFormat;
  if (@available(macOS 15.0, *)) {
    // Explicit SDR — Main10 still encodes SDR; HDR would need PQ/HLG transfer.
    configuration.captureDynamicRange = SCCaptureDynamicRangeSDR;
  }
  // Dynamic gamut detection: match SCKit's capture colour space AND the
  // file's AVVideoColorPropertiesKey to the target screen's actual gamut.
  // On a P3-capable display we tag Display P3 / P3-D65; on a non-P3 display
  // we tag sRGB / Rec.709. Keeping both ends in sync is what makes this
  // work — earlier attempts only switched the SCKit side, which produced
  // inconsistent file tags.
  BOOL p3Capable = targetScreen &&
      [targetScreen canRepresentDisplayGamut:NSDisplayGamutP3];
  if (p3Capable) {
    configuration.colorSpaceName = kCGColorSpaceDisplayP3;
    _configuredColorSpace = @"DisplayP3";
    _configuredColorPrimaries = AVVideoColorPrimaries_P3_D65;
    _configuredGamut = @"P3";
  } else {
    configuration.colorSpaceName = kCGColorSpaceSRGB;
    _configuredColorSpace = @"sRGB";
    _configuredColorPrimaries = AVVideoColorPrimaries_ITU_R_709_2;
    _configuredGamut = @"Rec.709";
  }
  configuration.backgroundColor = CGColorGetConstantColor(kCGColorBlack);

  // Compute compression properties up front so the bitrate / keyframe
  // values show up in the startup log alongside the rest of the config.
  // -prepareWriter: will read them later via -videoCompressionProperties.
  (void)[self videoCompressionProperties];

  NSLog(@"[openscreen.recorder] screen config: %ldx%ld @ %dfps  codec=%@  "
        @"pixelFormat=ARGB2101010LEPacked(l10r)  colorSpace=%@  "
        @"primaries=%@ (gamut=%@)  bitrate=%.1f Mbps  keyframeInterval=%ldf  "
        @"scale=%.2fx  pixelSizeSource=%@  scalesToFit=%@  queueDepth=5  "
        @"allowFrameReordering=NO",
        (long)_configuredWidth, (long)_configuredHeight,
        (int)(_options.fps > 0 ? _options.fps : 60),
        [self codecString], _configuredColorSpace,
        _configuredColorPrimaries, _configuredGamut,
        _configuredBitRate / 1'000'000.0,
        (long)_configuredKeyframeInterval,
        _configuredScaleFactor, _pixelSizeSource,
        configuration.scalesToFit ? @"YES" : @"NO");

  return configuration;
}

#pragma mark - AVAssetWriter

- (NSDictionary *)videoColorProperties {
  // Primaries follow whichever gamut was chosen in
  // -streamConfigurationForContent: (P3-D65 on a P3 display, Rec.709 on
  // sRGB-only displays). Transfer + YCbCr matrix stay Rec.709 in both cases
  // — that combination is the canonical SDR tag set across primaries.
  NSString *primaries = _configuredColorPrimaries ?: AVVideoColorPrimaries_P3_D65;
  return @{
    AVVideoColorPrimariesKey:   primaries,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey:      AVVideoYCbCrMatrix_ITU_R_709_2,
  };
}

- (NSDictionary *)videoCompressionProperties {
  NSInteger fps = _options.fps > 0 ? _options.fps : 60;

  // Bitrate tuned for SCREEN content (text, UI, fine edges) rather than
  // generic video. VideoToolbox's adaptive default for HEVC Main10 targets
  // around 5-10 Mbps even at 4K, which is fine for live-action but visibly
  // soft for desktop content. The native macOS screen recorder runs much
  // higher.
  //
  // Formula: ~0.1 bits per pixel per frame.
  //   3024 × 1964 @ 60fps  ≈ 36 Mbps   (matches QuickTime native recordings)
  //   1920 × 1080 @ 60fps  ≈ 12 Mbps
  //   3840 × 2160 @ 30fps  ≈ 25 Mbps
  // Floor at 8 Mbps so small displays still get crisp text.
  double bpp = 0.1;
  NSInteger bitRate = (NSInteger)(_configuredWidth * _configuredHeight * fps * bpp);
  if (bitRate < 8'000'000) bitRate = 8'000'000;

  // Keyframe every ~1 second. Screen content tends to be static for long
  // stretches; refreshing the I-frame regularly stops detail from drifting
  // through long P-frame chains.
  NSInteger maxKeyframeInterval = fps;

  _configuredBitRate = bitRate;
  _configuredKeyframeInterval = maxKeyframeInterval;

  return @{
    AVVideoAverageBitRateKey:          @(bitRate),
    AVVideoMaxKeyFrameIntervalKey:     @(maxKeyframeInterval),
    AVVideoExpectedSourceFrameRateKey: @(fps),
    AVVideoProfileLevelKey:            ProfileLevelForCodec(_codec),
    // Disable B-frames. They reference both past and future frames; on
    // text/UI content the bidirectional averaging produces a faint
    // smudging that's perceptible even at high bitrates. P-only streams
    // are slightly larger but visibly sharper.
    AVVideoAllowFrameReorderingKey:    @NO,
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
  _writer = [[AVAssetWriter alloc] initWithURL:_url
                                      fileType:AVFileTypeQuickTimeMovie
                                         error:&writerError];
  if (!_writer || writerError) {
    if (error) *error = writerError ?: MakeError(2303, @"Could not create AVAssetWriter");
    _writer = nil;
    return NO;
  }

  NSDictionary *videoSettings = @{
    AVVideoCodecKey:                 _codec,
    AVVideoWidthKey:                 @(_configuredWidth),
    AVVideoHeightKey:                @(_configuredHeight),
    AVVideoColorPropertiesKey:       [self videoColorProperties],
    AVVideoCompressionPropertiesKey: [self videoCompressionProperties],
  };

  _videoInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeVideo
                                               outputSettings:videoSettings];
  _videoInput.expectsMediaDataInRealTime = YES;
  // Pixel buffers come in as ARGB2101010LEPacked. AVAssetWriter handles the
  // RGB → 10-bit YCbCr conversion internally for the Main10 encoder.
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
  // 48 kHz stereo AAC at 192 kbps. Matches what SCStream delivers for the
  // sysaudio and microphone outputs after our configuration tweaks.
  AudioChannelLayout channelLayout;
  memset(&channelLayout, 0, sizeof(channelLayout));
  channelLayout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo;
  NSData *layoutData = [NSData dataWithBytes:&channelLayout length:sizeof(channelLayout)];
  return @{
    AVFormatIDKey:         @(kAudioFormatMPEG4AAC),
    AVSampleRateKey:       @48000,
    AVNumberOfChannelsKey: @2,
    AVEncoderBitRateKey:   @192000,
    AVChannelLayoutKey:    layoutData,
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
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) return;
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
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) return;
  [self appendAudioSampleBuffer:sampleBuffer
                        toInput:_systemAudioInput
                  droppedBefore:&_droppedSystemAudioBeforeStart];
}

- (void)appendMicrophoneSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) return;
  [self appendAudioSampleBuffer:sampleBuffer
                        toInput:_microphoneInput
                  droppedBefore:&_droppedMicrophoneBeforeStart];
}

#pragma mark - Lifecycle

- (void)markStopping {
  _stopping = YES;
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
  if (_writer.status == AVAssetWriterStatusCancelled) return YES;
  if (_writer.status == AVAssetWriterStatusUnknown) {
    // Never appended a sample.
    [_writer cancelWriting];
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
  if (_writer.status == AVAssetWriterStatusFailed) {
    if (error) {
      *error = _writer.error ?: MakeError(2310, @"AVAssetWriter finished with failure");
    }
    return NO;
  }
  return YES;
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
  if ([_codec isEqualToString:AVVideoCodecTypeHEVC]) return @"hevc-main10";
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
  meta[@"pixelFormat"] = @"ARGB2101010LEPacked";
  if ([_configuredColorPrimaries isEqualToString:AVVideoColorPrimaries_P3_D65]) {
    meta[@"colorPrimaries"] = @"P3_D65";
  } else if ([_configuredColorPrimaries isEqualToString:AVVideoColorPrimaries_ITU_R_709_2]) {
    meta[@"colorPrimaries"] = @"ITU_R_709_2";
  } else if (_configuredColorPrimaries) {
    meta[@"colorPrimaries"] = _configuredColorPrimaries;
  }
  meta[@"colorTransfer"] = @"ITU_R_709_2";
  meta[@"colorMatrix"] = @"ITU_R_709_2";
  if (_configuredGamut) meta[@"gamut"] = _configuredGamut;
  if (_configuredBitRate > 0) meta[@"averageBitRate"] = @(_configuredBitRate);
  if (_configuredKeyframeInterval > 0) {
    meta[@"maxKeyFrameInterval"] = @(_configuredKeyframeInterval);
  }
  meta[@"allowFrameReordering"] = @NO;
  meta[@"queueDepth"] = @5;
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
  if (_writer.error) {
    meta[@"error"] = _writer.error.localizedDescription ?: @"";
  }
  return meta;
}

@end
