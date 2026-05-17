#include "SystemAudioTrack.h"

#import <AVFoundation/AVFoundation.h>

#include "ScreenTrack.h"

@implementation SystemAudioTrack {
  RecordingOptions _options;
  __weak ScreenTrack *_screenTrack;
  dispatch_queue_t _queue;
  BOOL _stopping;
  NSInteger _samplesForwarded;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options
                    screenTrack:(ScreenTrack *)screenTrack {
  self = [super init];
  if (self) {
    _options = options;
    _screenTrack = screenTrack;
    _queue = dispatch_queue_create("openscreen.sck.system-audio", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (BOOL)isEnabled {
  return _options.recordSystemAudio;
}

- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration {
  configuration.capturesAudio = _options.recordSystemAudio;
  configuration.sampleRate = 48000;
  configuration.channelCount = 2;
  configuration.excludesCurrentProcessAudio = YES;
}

- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error {
  if (!_options.recordSystemAudio) return YES;
  NSError *addOutputError = nil;
  if (![stream addStreamOutput:self
                          type:SCStreamOutputTypeAudio
            sampleHandlerQueue:_queue
                         error:&addOutputError]) {
    if (error) {
      *error = addOutputError ?: MakeError(2502, @"Could not add system audio output");
    }
    return NO;
  }
  return YES;
}

- (void)markStopping { _stopping = YES; }

- (NSDictionary *)metadata {
  if (!_options.recordSystemAudio) return nil;
  NSMutableDictionary *meta = [@{
    @"source": @"systemAudio",
    @"muxedInto": @"screen",
    @"sampleRate": @48000,
    @"channelCount": @2,
    @"samplesForwarded": @(_samplesForwarded),
  } mutableCopy];
  if (_options.target.type == "window") {
    meta[@"captureScope"] = @"owningApplication";
    if (!_options.target.applicationName.empty()) {
      meta[@"applicationName"] = ToNSString(_options.target.applicationName);
    }
    if (!_options.target.bundleId.empty()) {
      meta[@"bundleId"] = ToNSString(_options.target.bundleId);
    }
  } else {
    meta[@"captureScope"] = @"filter";
  }
  if (!_options.audioApplicationBundleIds.empty()) {
    NSMutableArray<NSString *> *ids =
        [NSMutableArray arrayWithCapacity:_options.audioApplicationBundleIds.size()];
    for (const std::string &bid : _options.audioApplicationBundleIds) {
      if (bid.empty()) continue;
      [ids addObject:ToNSString(bid)];
    }
    if (ids.count > 0) {
      meta[@"audioApplicationBundleIds"] = ids;
    }
  }
  return meta;
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) return;
  if (type != SCStreamOutputTypeAudio) return;
  ScreenTrack *screenTrack = _screenTrack;
  if (!screenTrack) return;
  [screenTrack appendSystemAudioSampleBuffer:sampleBuffer];
  _samplesForwarded++;
}

@end
