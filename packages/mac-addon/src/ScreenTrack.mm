#include "ScreenTrack.h"

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include "MediaFileWriter.h"

@implementation ScreenTrack {
  RecordingOptions _options;
  NSURL *_url;
  OSMediaFileWriter *_writer;
  dispatch_queue_t _queue;
  BOOL _stopping;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _queue = dispatch_queue_create("openscreen.sck.screen", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)setOutputURL:(NSURL *)url {
  _url = url;
}

- (void)prepareWriter {
  _writer = [[OSMediaFileWriter alloc] initWithURL:_url
                                            source:@"screen"
                                         mediaType:AVMediaTypeVideo
                                          fileType:AVFileTypeQuickTimeMovie];
}

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
  if (!_options.excludeOwnApp) {
    return @[];
  }
  NSString *ownBundle = [[NSBundle mainBundle] bundleIdentifier];
  if (ownBundle.length == 0) {
    return @[];
  }

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
      if (error) {
        *error = MakeError(2201, @"Requested window was not found");
      }
      return nil;
    }
    return [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
  }

  SCDisplay *display = [self displayFromContent:content];
  if (!display) {
    if (error) {
      *error = MakeError(2202, @"No display is available to capture");
    }
    return nil;
  }

  if (_options.target.type == "application") {
    SCRunningApplication *app = [self applicationFromContent:content];
    if (!app) {
      if (error) {
        *error = MakeError(2203, @"Requested application was not found");
      }
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

- (SCStreamConfiguration *)streamConfigurationForContent:(SCShareableContent *)content {
  SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
  int width = _options.width;
  int height = _options.height;

  if (width <= 0 || height <= 0) {
    if (_options.target.type == "window") {
      SCWindow *window = [self windowFromContent:content];
      CGFloat scale = [[NSScreen mainScreen] backingScaleFactor] ?: 2.0;
      width = (int)MAX(640, window.frame.size.width * scale);
      height = (int)MAX(360, window.frame.size.height * scale);
    } else {
      SCDisplay *display = [self displayFromContent:content];
      width = (int)MAX(640, display.width);
      height = (int)MAX(360, display.height);
    }
  }

  configuration.width = width;
  configuration.height = height;
  configuration.minimumFrameInterval = CMTimeMake(1, _options.fps > 0 ? _options.fps : 30);
  configuration.queueDepth = 5;
  configuration.showsCursor = _options.includeCursor;
  configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
  return configuration;
}

- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error {
  NSError *addOutputError = nil;
  if (![stream addStreamOutput:self
                          type:SCStreamOutputTypeScreen
            sampleHandlerQueue:_queue
                         error:&addOutputError]) {
    if (error) {
      *error = addOutputError ?: MakeError(2501, @"Could not add screen stream output");
    }
    return NO;
  }
  return YES;
}

- (void)markStopping {
  _stopping = YES;
}

- (BOOL)finishWriterSync:(NSError **)error {
  if (!_writer) return YES;
  return [_writer finishSync:error];
}

- (void)cancelWriter {
  [_writer cancel];
}

- (NSDictionary *)writerMetadata {
  return _writer ? [_writer metadata] : nil;
}

- (NSURL *)url {
  return _url;
}

- (BOOL)hasWriter {
  return _writer != nil;
}

- (BOOL)isCompleteScreenFrame:(CMSampleBufferRef)sampleBuffer {
  CFArrayRef attachmentsArray =
      CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (!attachmentsArray || CFArrayGetCount(attachmentsArray) == 0) {
    return YES;
  }
  NSDictionary *attachments =
      (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachmentsArray, 0);
  NSNumber *statusNumber = attachments[SCStreamFrameInfoStatus];
  if (!statusNumber) {
    return YES;
  }
  SCFrameStatus status = (SCFrameStatus)[statusNumber integerValue];
  return status == SCFrameStatusComplete || status == SCFrameStatusStarted;
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }
  if (type != SCStreamOutputTypeScreen) {
    return;
  }
  if ([self isCompleteScreenFrame:sampleBuffer]) {
    [_writer appendSampleBuffer:sampleBuffer];
  }
}

@end
