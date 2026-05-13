#include "MicrophoneTrack.h"

#import <AVFoundation/AVFoundation.h>

#include "ScreenTrack.h"

@implementation MicrophoneTrack {
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
    _queue = dispatch_queue_create("openscreen.sck.microphone", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (BOOL)isEnabled {
  return _options.recordMicrophone;
}

- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration {
  if (!_options.recordMicrophone) return;
  configuration.captureMicrophone = YES;
  if (!_options.microphoneDeviceId.empty()) {
    configuration.microphoneCaptureDeviceID = ToNSString(_options.microphoneDeviceId);
  }
}

- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error {
  if (!_options.recordMicrophone) return YES;
  NSError *addOutputError = nil;
  if (![stream addStreamOutput:self
                          type:SCStreamOutputTypeMicrophone
            sampleHandlerQueue:_queue
                         error:&addOutputError]) {
    if (error) {
      *error = addOutputError ?: MakeError(2503, @"Could not add microphone output");
    }
    return NO;
  }
  return YES;
}

- (void)markStopping { _stopping = YES; }

- (NSDictionary *)metadata {
  if (!_options.recordMicrophone) return nil;
  NSMutableDictionary *meta = [NSMutableDictionary dictionary];
  meta[@"source"] = @"microphone";
  meta[@"muxedInto"] = @"screen";
  meta[@"samplesForwarded"] = @(_samplesForwarded);
  if (!_options.microphoneDeviceId.empty()) {
    meta[@"deviceId"] = ToNSString(_options.microphoneDeviceId);
  }
  return meta;
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) return;
  if (type != SCStreamOutputTypeMicrophone) return;
  ScreenTrack *screenTrack = _screenTrack;
  if (!screenTrack) return;
  [screenTrack appendMicrophoneSampleBuffer:sampleBuffer];
  _samplesForwarded++;
}

@end
