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
  // SCStream-based microphone capture (`captureMicrophone`,
  // `microphoneCaptureDeviceID`) is macOS 15.0+ only. The selectors don't
  // exist on 13/14, so attempting to use the SCK mic path there would throw
  // NSInvalidArgumentException. Report disabled so the rest of the pipeline
  // never asks us to wire a mic input.
  if (!_options.recordMicrophone) return NO;
  if (@available(macOS 15.0, *)) return YES;
  return NO;
}

- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration {
  if (!_options.recordMicrophone) return;
  if (@available(macOS 15.0, *)) {
    configuration.captureMicrophone = YES;
    if (!_options.microphoneDeviceId.empty()) {
      configuration.microphoneCaptureDeviceID = ToNSString(_options.microphoneDeviceId);
    }
  }
}

- (BOOL)addToStream:(SCStream *)stream error:(NSError **)error {
  // -isEnabled bakes in the 15+ availability check; on macOS 13/14 this
  // returns NO and we skip the SCStreamOutputTypeMicrophone wiring entirely
  // (the enum value itself is also 15+).
  if (![self isEnabled]) return YES;
  if (@available(macOS 15.0, *)) {
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
  // SCStreamOutputTypeMicrophone is macOS 15+. -addToStream: only registers
  // this delegate on 15+ too, so reaching here implies the symbol exists at
  // runtime — the @available gate just silences the unguarded-symbol warning.
  if (@available(macOS 15.0, *)) {
    if (type != SCStreamOutputTypeMicrophone) return;
  } else {
    return;
  }
  ScreenTrack *screenTrack = _screenTrack;
  if (!screenTrack) return;
  [screenTrack appendMicrophoneSampleBuffer:sampleBuffer];
  _samplesForwarded++;
}

@end
