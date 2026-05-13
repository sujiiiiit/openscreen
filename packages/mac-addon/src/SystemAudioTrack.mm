#include "SystemAudioTrack.h"

#import <AVFoundation/AVFoundation.h>

#include "MediaFileWriter.h"

@implementation SystemAudioTrack {
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
    _queue = dispatch_queue_create("openscreen.sck.system-audio", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (BOOL)isEnabled {
  return _options.recordSystemAudio;
}

- (void)setOutputURL:(NSURL *)url {
  _url = url;
}

- (void)prepareWriter {
  if (!_options.recordSystemAudio) return;
  _writer = [[OSMediaFileWriter alloc] initWithURL:_url
                                            source:@"systemAudio"
                                         mediaType:AVMediaTypeAudio
                                          fileType:AVFileTypeAppleM4A];
}

- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration {
  if (@available(macOS 13.0, *)) {
    configuration.capturesAudio = _options.recordSystemAudio;
    configuration.sampleRate = 48000;
    configuration.channelCount = 2;
    configuration.excludesCurrentProcessAudio = YES;
  }
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

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }
  if (@available(macOS 13.0, *)) {
    if (type == SCStreamOutputTypeAudio) {
      [_writer appendSampleBuffer:sampleBuffer];
    }
  }
}

@end
