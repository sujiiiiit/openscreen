#include "CameraTrack.h"

#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>

#include "CameraPreview.h"
#include "Devices.h"
#include "MediaFileWriter.h"

@implementation CameraTrack {
  RecordingOptions _options;
  NSURL *_url;
  OSMediaFileWriter *_writer;
  AVCaptureSession *_session;
  AVCaptureVideoDataOutput *_cameraOutput;
  AVCaptureVideoDataOutput *_previewOutput;
  dispatch_queue_t _cameraQueue;
  dispatch_queue_t _previewQueue;
  BOOL _stopping;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _cameraQueue = dispatch_queue_create("openscreen.av.camera", DISPATCH_QUEUE_SERIAL);
    _previewQueue = dispatch_queue_create("openscreen.av.camera-preview-tap", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (BOOL)isEnabled {
  return _options.recordCamera;
}

- (NSString *)deviceId {
  return ToNSString(_options.cameraDeviceId);
}

- (void)setOutputURL:(NSURL *)url {
  _url = url;
}

- (void)prepareWriter {
  if (!_options.recordCamera) return;
  _writer = [[OSMediaFileWriter alloc] initWithURL:_url
                                            source:@"camera"
                                         mediaType:AVMediaTypeVideo
                                          fileType:AVFileTypeQuickTimeMovie];
}

- (BOOL)setupAVCaptureSession:(NSError **)error {
  if (!_options.recordCamera) {
    return YES;
  }

  AVCaptureDevice *device = CaptureDeviceForUniqueID(_options.cameraDeviceId,
                                                     AVMediaTypeVideo);
  if (!device) {
    if (error) {
      *error = MakeError(2301, @"No camera device is available");
    }
    return NO;
  }

  NSError *inputError = nil;
  AVCaptureDeviceInput *input =
      [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
  if (!input || inputError) {
    if (error) {
      *error = inputError ?: MakeError(2302, @"Could not create camera input");
    }
    return NO;
  }

  _session = [[AVCaptureSession alloc] init];
  _session.sessionPreset = AVCaptureSessionPresetHigh;
  [_session beginConfiguration];
  if ([_session canAddInput:input]) {
    [_session addInput:input];
  } else {
    if (error) {
      *error = MakeError(2303, @"Could not add camera input");
    }
    return NO;
  }

  _cameraOutput = [[AVCaptureVideoDataOutput alloc] init];
  _cameraOutput.videoSettings = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey :
        @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
  };
  _cameraOutput.alwaysDiscardsLateVideoFrames = YES;
  [_cameraOutput setSampleBufferDelegate:self queue:_cameraQueue];
  if ([_session canAddOutput:_cameraOutput]) {
    [_session addOutput:_cameraOutput];
  } else {
    if (error) {
      *error = MakeError(2304, @"Could not add camera output");
    }
    return NO;
  }
  [_session commitConfiguration];
  return YES;
}

- (void)startCapture {
  [_session startRunning];
}

- (void)stopCapture {
  [_session stopRunning];
}

- (void)resetCapture {
  _session = nil;
  _cameraOutput = nil;
  _previewOutput = nil;
}

- (BOOL)hasCaptureSession {
  return _session != nil;
}

- (BOOL)attachPreviewOutput:(NSError **)error {
  if (_previewOutput != nil) {
    return YES;
  }
  if (_session == nil) {
    if (error) *error = MakeError(2601, @"Cannot attach preview output: no camera session");
    return NO;
  }

  AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
  output.videoSettings = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
  };
  output.alwaysDiscardsLateVideoFrames = YES;
  [output setSampleBufferDelegate:self queue:_previewQueue];

  [_session beginConfiguration];
  if (![_session canAddOutput:output]) {
    [_session commitConfiguration];
    if (error) *error = MakeError(2602, @"Could not attach preview output to camera session");
    return NO;
  }
  [_session addOutput:output];
  AVCaptureConnection *connection = [output connectionWithMediaType:AVMediaTypeVideo];
  if (connection.isVideoMinFrameDurationSupported) {
    connection.videoMinFrameDuration = CMTimeMake(1, 30);
  }
  if (connection.isVideoMaxFrameDurationSupported) {
    connection.videoMaxFrameDuration = CMTimeMake(1, 30);
  }
  [_session commitConfiguration];
  _previewOutput = output;
  return YES;
}

- (void)detachPreviewOutput {
  if (_previewOutput == nil) return;
  AVCaptureVideoDataOutput *output = _previewOutput;
  _previewOutput = nil;
  [output setSampleBufferDelegate:nil queue:nil];
  if (_session) {
    [_session beginConfiguration];
    [_session removeOutput:output];
    [_session commitConfiguration];
  }
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

- (void)setPaused:(BOOL)paused {
  [_writer setPaused:paused];
}

- (NSURL *)url {
  return _url;
}

- (BOOL)hasWriter {
  return _writer != nil;
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }

  if (output == _cameraOutput) {
    [_writer appendSampleBuffer:sampleBuffer];
  } else if (output == _previewOutput) {
    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (pixelBuffer) {
      DeliverPreviewFrame(pixelBuffer);
    }
  }
}

@end
