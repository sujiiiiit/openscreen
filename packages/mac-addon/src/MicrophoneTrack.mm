#include "MicrophoneTrack.h"

#include "Devices.h"
#include "MediaFileWriter.h"

@implementation MicrophoneTrack {
  RecordingOptions _options;
  NSURL *_url;
  OSMediaFileWriter *_writer;
  dispatch_queue_t _queue;
  AVCaptureSession *_session;
  AVCaptureAudioDataOutput *_output;
  BOOL _usesScreenCaptureKit;
  BOOL _stopping;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _queue = dispatch_queue_create("openscreen.sck.microphone", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (BOOL)isEnabled {
  return _options.recordMicrophone;
}

- (BOOL)usesScreenCaptureKit {
  return _usesScreenCaptureKit;
}

- (void)setOutputURL:(NSURL *)url {
  _url = url;
}

- (void)prepareWriter {
  if (!_options.recordMicrophone) return;
  _writer = [[OSMediaFileWriter alloc] initWithURL:_url
                                            source:@"microphone"
                                         mediaType:AVMediaTypeAudio
                                          fileType:AVFileTypeAppleM4A];
}

- (void)configureSCStreamConfig:(SCStreamConfiguration *)configuration {
  if (@available(macOS 15.0, *)) {
    if (_options.recordMicrophone) {
      configuration.captureMicrophone = YES;
      if (!_options.microphoneDeviceId.empty()) {
        configuration.microphoneCaptureDeviceID = ToNSString(_options.microphoneDeviceId);
      }
      _usesScreenCaptureKit = YES;
    }
  }
}

- (BOOL)setupFallbackIfNeeded:(NSError **)error {
  if (!_options.recordMicrophone || _usesScreenCaptureKit) {
    return YES;
  }

  AVCaptureDevice *device = CaptureDeviceForUniqueID(_options.microphoneDeviceId,
                                                     AVMediaTypeAudio);
  if (!device) {
    if (error) {
      *error = MakeError(2401, @"No microphone device is available");
    }
    return NO;
  }

  NSError *inputError = nil;
  AVCaptureDeviceInput *input =
      [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
  if (!input || inputError) {
    if (error) {
      *error = inputError ?: MakeError(2402, @"Could not create microphone input");
    }
    return NO;
  }

  _session = [[AVCaptureSession alloc] init];
  [_session beginConfiguration];
  if ([_session canAddInput:input]) {
    [_session addInput:input];
  } else {
    if (error) {
      *error = MakeError(2403, @"Could not add microphone input");
    }
    return NO;
  }

  _output = [[AVCaptureAudioDataOutput alloc] init];
  [_output setSampleBufferDelegate:self queue:_queue];
  if ([_session canAddOutput:_output]) {
    [_session addOutput:_output];
  } else {
    if (error) {
      *error = MakeError(2404, @"Could not add microphone output");
    }
    return NO;
  }
  [_session commitConfiguration];
  return YES;
}

- (void)startFallback {
  [_session startRunning];
}

- (void)stopFallback {
  [_session stopRunning];
}

- (void)resetFallback {
  _session = nil;
  _output = nil;
}

- (BOOL)addSCKitOutputToStream:(SCStream *)stream error:(NSError **)error {
  if (!_usesScreenCaptureKit) return YES;
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

- (void)markStopping {
  _stopping = YES;
}

- (BOOL)ownsCaptureOutput:(AVCaptureOutput *)output {
  return output == _output;
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
  if (@available(macOS 15.0, *)) {
    if (type == SCStreamOutputTypeMicrophone) {
      [_writer appendSampleBuffer:sampleBuffer];
    }
  }
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }
  if (output == _output) {
    [_writer appendSampleBuffer:sampleBuffer];
  }
}

@end
