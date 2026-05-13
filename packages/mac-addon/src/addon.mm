#include <napi.h>

#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

struct CaptureTarget {
  std::string type = "display";
  uint32_t displayId = 0;
  uint32_t windowId = 0;
  std::string bundleId;
};

struct RecordingOptions {
  std::string sessionId;
  std::string outputDir;
  std::string basename;
  CaptureTarget target;
  int fps = 30;
  int width = 0;
  int height = 0;
  bool includeCursor = true;
  bool recordSystemAudio = true;
  bool recordMicrophone = false;
  bool recordCamera = false;
  bool excludeOwnApp = true;
  std::string microphoneDeviceId;
  std::string cameraDeviceId;
};

struct EventPayload {
  std::string type;
  std::string sessionId;
  std::string source;
  std::string message;
  double durationMs = 0;
};

struct DisplayInfo {
  uint32_t id = 0;
  int64_t width = 0;
  int64_t height = 0;
  double x = 0;
  double y = 0;
};

struct WindowInfo {
  uint32_t id = 0;
  std::string title;
  std::string appName;
  std::string bundleId;
  int pid = 0;
  bool onScreen = false;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

struct AppInfo {
  std::string name;
  std::string bundleId;
  int pid = 0;
};

static std::mutex gEventMutex;
static std::unique_ptr<Napi::ThreadSafeFunction> gEventCallback;

static NSString *ToNSString(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()];
}

static std::string ToStdString(NSString *value) {
  return value == nil ? std::string() : std::string([value UTF8String]);
}

static bool IsMacOSAtLeast(NSInteger major) {
  NSOperatingSystemVersion version =
      [[NSProcessInfo processInfo] operatingSystemVersion];
  return version.majorVersion >= major;
}

static std::string NewSessionId() {
  return ToStdString([[NSUUID UUID] UUIDString]);
}

static std::string PermissionState(AVAuthorizationStatus status) {
  switch (status) {
    case AVAuthorizationStatusAuthorized:
      return "granted";
    case AVAuthorizationStatusDenied:
      return "denied";
    case AVAuthorizationStatusRestricted:
      return "restricted";
    case AVAuthorizationStatusNotDetermined:
    default:
      return "notDetermined";
  }
}

static double TimeToMilliseconds(CMTime time) {
  if (!CMTIME_IS_VALID(time) || CMTIME_IS_INDEFINITE(time)) {
    return 0;
  }
  Float64 seconds = CMTimeGetSeconds(time);
  if (!std::isfinite(seconds)) {
    return 0;
  }
  return seconds * 1000.0;
}

static NSString *NSErrorDomain() {
  return @"OpenScreenRecorder";
}

static NSError *MakeError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:NSErrorDomain()
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

static std::string GetStringProp(Napi::Object object,
                                 const char *name,
                                 const std::string &fallback = "") {
  Napi::Value value = object.Get(name);
  return value.IsString() ? value.As<Napi::String>().Utf8Value() : fallback;
}

static bool GetBoolProp(Napi::Object object,
                        const char *name,
                        bool fallback = false) {
  Napi::Value value = object.Get(name);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

static int GetIntProp(Napi::Object object, const char *name, int fallback = 0) {
  Napi::Value value = object.Get(name);
  return value.IsNumber() ? value.As<Napi::Number>().Int32Value() : fallback;
}

static uint32_t GetUint32Prop(Napi::Object object,
                              const char *name,
                              uint32_t fallback = 0) {
  Napi::Value value = object.Get(name);
  return value.IsNumber() ? value.As<Napi::Number>().Uint32Value() : fallback;
}

static void EmitEvent(const EventPayload &payload) {
  std::lock_guard<std::mutex> lock(gEventMutex);
  if (!gEventCallback) {
    return;
  }

  auto *data = new EventPayload(payload);
  napi_status status = gEventCallback->NonBlockingCall(
      data, [](Napi::Env env, Napi::Function callback, EventPayload *event) {
        Napi::Object object = Napi::Object::New(env);
        object.Set("type", event->type);
        object.Set("sessionId", event->sessionId);
        if (!event->source.empty()) {
          object.Set("source", event->source);
        }
        if (!event->message.empty()) {
          object.Set("message", event->message);
        }
        if (event->durationMs > 0) {
          object.Set("durationMs", event->durationMs);
        }
        callback.Call({object});
        if (env.IsExceptionPending()) {
          env.GetAndClearPendingException();
        }
        delete event;
      });

  if (status != napi_ok) {
    delete data;
  }
}

}  // namespace

@class RecorderSession;

@interface OSCameraPreviewSession : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
- (instancetype)initWithDeviceId:(NSString *)deviceId;
- (BOOL)startWithError:(NSError **)error;
- (void)stop;
@end

struct CameraPreviewFrame {
  std::vector<uint8_t> data;
  int width = 0;
  int height = 0;
  int rowBytes = 0;
};

static std::mutex gPreviewMutex;
static std::mutex gPreviewOperationMutex;
static std::unique_ptr<Napi::ThreadSafeFunction> gPreviewCallback;
static NSString *gPreviewDeviceId = nil;
static __weak RecorderSession *gPreviewHostRecorder = nil;
static __weak RecorderSession *gActiveRecorder = nil;
static OSCameraPreviewSession *gPreviewSession = nil;
static uint64_t gPreviewGeneration = 0;
static std::atomic<bool> gPreviewCallbackExceptionLogged(false);

// Free-list of reusable preview frame buffers. Bounded so we don't pin large
// vectors after the preview stops; surplus frames are dropped at recycle time.
static std::mutex gPreviewPoolMutex;
static std::vector<std::unique_ptr<CameraPreviewFrame>> gPreviewPool;
static constexpr size_t kPreviewPoolCap = 6;

static std::unique_ptr<CameraPreviewFrame> AcquirePreviewFrame() {
  std::lock_guard<std::mutex> lock(gPreviewPoolMutex);
  if (gPreviewPool.empty()) {
    return std::unique_ptr<CameraPreviewFrame>(new CameraPreviewFrame());
  }
  std::unique_ptr<CameraPreviewFrame> frame = std::move(gPreviewPool.back());
  gPreviewPool.pop_back();
  return frame;
}

static void RecyclePreviewFrame(std::unique_ptr<CameraPreviewFrame> frame) {
  if (!frame) return;
  std::lock_guard<std::mutex> lock(gPreviewPoolMutex);
  if (gPreviewPool.size() < kPreviewPoolCap) {
    gPreviewPool.push_back(std::move(frame));
  }
}

static void ClearPreviewPool() {
  std::lock_guard<std::mutex> lock(gPreviewPoolMutex);
  gPreviewPool.clear();
}

static void ClearPendingPreviewException(Napi::Env env) {
  if (!env.IsExceptionPending()) return;

  Napi::Error error = env.GetAndClearPendingException();
  if (!gPreviewCallbackExceptionLogged.exchange(true, std::memory_order_relaxed)) {
    EmitEvent({"error", "", "cameraPreview", error.Message(), 0});
  }
}

static uint64_t NextPreviewGeneration() {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  gPreviewCallbackExceptionLogged.store(false, std::memory_order_relaxed);
  return ++gPreviewGeneration;
}

static BOOL IsCurrentPreviewGeneration(uint64_t generation) {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  return gPreviewGeneration == generation;
}

static RecorderSession *ActiveRecorderForPreview() {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  return gActiveRecorder;
}

static void SetActiveRecorder(RecorderSession *recorder) {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  gActiveRecorder = recorder;
}

static void ClearActiveRecorder(RecorderSession *recorder) {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  if (gActiveRecorder == recorder) {
    gActiveRecorder = nil;
  }
}

static void DeliverPreviewFrame(CVPixelBufferRef pixelBuffer);

@interface OSMediaFileWriter : NSObject
- (instancetype)initWithURL:(NSURL *)url
                     source:(NSString *)source
                  mediaType:(AVMediaType)mediaType
                   fileType:(AVFileType)fileType;
- (void)appendSampleBuffer:(CMSampleBufferRef)sampleBuffer;
- (BOOL)finishSync:(NSError **)error;
- (void)cancel;
- (NSDictionary *)metadata;
- (NSString *)source;
- (NSString *)path;
- (BOOL)hasStarted;
@end

@implementation OSMediaFileWriter {
  NSURL *_url;
  NSString *_source;
  AVMediaType _mediaType;
  AVFileType _fileType;
  AVAssetWriter *_writer;
  AVAssetWriterInput *_input;
  dispatch_queue_t _queue;
  NSError *_error;
  BOOL _started;
  BOOL _finishing;
  BOOL _finished;
  CMTime _firstPTS;
  CMTime _lastPTS;
  CMTime _firstHostOffset;
  NSInteger _width;
  NSInteger _height;
  NSInteger _sampleRate;
  NSInteger _channelCount;
  int64_t _sampleCount;
  // Bounded-inflight backpressure. _inflight counts buffers retained by the
  // producer and enqueued onto _queue but not yet appended; if it crosses
  // _inflightCap we drop the next sample (with CFRelease elided) and bump
  // _droppedCount so the manifest records the loss. Without this, a stalled
  // disk or encoder would let CMSampleBuffers (and the IOSurfaces they pin)
  // accumulate without bound.
  std::atomic<int> _inflight;
  std::atomic<int64_t> _droppedCount;
  int _inflightCap;
  BOOL _backpressureEventSent;
}

- (instancetype)initWithURL:(NSURL *)url
                     source:(NSString *)source
                  mediaType:(AVMediaType)mediaType
                   fileType:(AVFileType)fileType {
  self = [super init];
  if (self) {
    _url = url;
    _source = [source copy];
    _mediaType = mediaType;
    _fileType = fileType;
    _queue = dispatch_queue_create(
        [[NSString stringWithFormat:@"openscreen.writer.%@", source] UTF8String],
        DISPATCH_QUEUE_SERIAL);
    _firstPTS = kCMTimeInvalid;
    _lastPTS = kCMTimeInvalid;
    _firstHostOffset = kCMTimeInvalid;
    // std::atomic default-ctor leaves the value indeterminate pre-C++20; init
    // explicitly so the very first compare/load is well-defined.
    _inflight.store(0, std::memory_order_relaxed);
    _droppedCount.store(0, std::memory_order_relaxed);
    // Video frames pin large IOSurfaces, so the cap is tight. Audio packets
    // are tiny (a few KB) and can buffer more comfortably.
    _inflightCap = [mediaType isEqualToString:AVMediaTypeVideo] ? 8 : 64;
    _backpressureEventSent = NO;
  }
  return self;
}

- (NSString *)source {
  return _source;
}

- (NSString *)path {
  return [_url path];
}

- (BOOL)hasStarted {
  __block BOOL result = NO;
  dispatch_sync(_queue, ^{
    result = _started;
  });
  return result;
}

- (NSDictionary *)metadata {
  __block NSDictionary *result = nil;
  dispatch_sync(_queue, ^{
    NSNumber *fileSize = @0;
    NSDictionary *attrs =
        [[NSFileManager defaultManager] attributesOfItemAtPath:[_url path]
                                                         error:nil];
    if (attrs[NSFileSize]) {
      fileSize = attrs[NSFileSize];
    }

    NSMutableDictionary *metadata = [NSMutableDictionary dictionary];
    metadata[@"source"] = _source;
    metadata[@"path"] = [_url path];
    metadata[@"started"] = @(_started);
    metadata[@"finished"] = @(_finished);
    metadata[@"samples"] = @(_sampleCount);
    metadata[@"fileSize"] = fileSize;
    metadata[@"firstPtsMs"] = @(TimeToMilliseconds(_firstPTS));
    metadata[@"lastPtsMs"] = @(TimeToMilliseconds(_lastPTS));
    if (CMTIME_IS_VALID(_firstPTS) && CMTIME_IS_VALID(_lastPTS)) {
      metadata[@"durationMs"] = @(TimeToMilliseconds(CMTimeSubtract(_lastPTS, _firstPTS)));
    } else {
      metadata[@"durationMs"] = @0;
    }
    if (_width > 0) {
      metadata[@"width"] = @(_width);
    }
    if (_height > 0) {
      metadata[@"height"] = @(_height);
    }
    if (_sampleRate > 0) {
      metadata[@"sampleRate"] = @(_sampleRate);
    }
    if (_channelCount > 0) {
      metadata[@"channelCount"] = @(_channelCount);
    }
    if (_error) {
      metadata[@"error"] = [_error localizedDescription];
    }
    int64_t dropped = _droppedCount.load(std::memory_order_relaxed);
    if (dropped > 0) {
      metadata[@"droppedSamples"] = @(dropped);
    }
    result = metadata;
  });
  return result;
}

- (BOOL)createWriterForSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_writer != nil) {
    return YES;
  }

  [[NSFileManager defaultManager] removeItemAtURL:_url error:nil];

  NSError *writerError = nil;
  _writer = [[AVAssetWriter alloc] initWithURL:_url
                                      fileType:_fileType
                                         error:&writerError];
  if (!_writer || writerError) {
    _error = writerError ?: MakeError(1001, @"Could not create media writer");
    return NO;
  }

  CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sampleBuffer);
  NSDictionary *settings = nil;

  if ([_mediaType isEqualToString:AVMediaTypeVideo]) {
    CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format);
    _width = dimensions.width;
    _height = dimensions.height;
    settings = @{
      AVVideoCodecKey : AVVideoCodecTypeH264,
      AVVideoWidthKey : @(_width),
      AVVideoHeightKey : @(_height),
      AVVideoCompressionPropertiesKey : @{
        AVVideoAverageBitRateKey : @(MAX(2'500'000, _width * _height * 4)),
        AVVideoExpectedSourceFrameRateKey : @30,
        AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
      }
    };
  } else if ([_mediaType isEqualToString:AVMediaTypeAudio]) {
    const AudioStreamBasicDescription *asbd =
        CMAudioFormatDescriptionGetStreamBasicDescription(format);
    _sampleRate = asbd ? (NSInteger)asbd->mSampleRate : 48000;
    _channelCount = asbd ? (NSInteger)asbd->mChannelsPerFrame : 2;
    if (_channelCount <= 0) {
      _channelCount = 1;
    }
    settings = @{
      AVFormatIDKey : @(kAudioFormatMPEG4AAC),
      AVSampleRateKey : @(_sampleRate),
      AVNumberOfChannelsKey : @(_channelCount),
      AVEncoderBitRateKey : @(128000),
    };
  }

  _input = [[AVAssetWriterInput alloc] initWithMediaType:_mediaType
                                          outputSettings:settings
                                        sourceFormatHint:format];
  _input.expectsMediaDataInRealTime = YES;

  if (![_writer canAddInput:_input]) {
    _error = MakeError(1002, @"Could not add media input to writer");
    return NO;
  }
  [_writer addInput:_input];
  return YES;
}

- (void)appendRetainedSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_finishing || _finished || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }

  if (![self createWriterForSampleBuffer:sampleBuffer]) {
    EmitEvent({"error", "", ToStdString(_source), ToStdString([_error localizedDescription]), 0});
    return;
  }

  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (!CMTIME_IS_VALID(pts)) {
    pts = CMClockGetTime(CMClockGetHostTimeClock());
  }

  if (!_started) {
    if (![_writer startWriting]) {
      _error = [_writer error] ?: MakeError(1003, @"Could not start media writer");
      return;
    }
    [_writer startSessionAtSourceTime:pts];
    _firstPTS = pts;
    _started = YES;
    EmitEvent({"fileStarted", "", ToStdString(_source), ToStdString([_url path]), 0});
  }

  if (_input.readyForMoreMediaData) {
    if (![_input appendSampleBuffer:sampleBuffer]) {
      _error = [_writer error] ?: MakeError(1004, @"Could not append sample buffer");
      EmitEvent({"error", "", ToStdString(_source), ToStdString([_error localizedDescription]), 0});
      return;
    }
    _lastPTS = pts;
    _sampleCount += 1;
  }
}

- (void)appendSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (!sampleBuffer) {
    return;
  }
  // A late append racing with -cancel/-finishSync would do real work for
  // nothing and could touch a writer that's already torn down; bail early.
  if (_finishing || _finished) {
    return;
  }

  // Bounded backpressure: if the writer queue is already saturated, drop
  // this sample rather than enqueue another and let memory grow without
  // bound. We emit a single event so the UI can warn the user; subsequent
  // drops are tallied in _droppedCount and reported via -metadata.
  int current = _inflight.load(std::memory_order_acquire);
  if (current >= _inflightCap) {
    _droppedCount.fetch_add(1, std::memory_order_relaxed);
    if (!_backpressureEventSent) {
      _backpressureEventSent = YES;
      EmitEvent({"backpressure", "", ToStdString(_source),
                 "writer dropping samples to bound memory", 0});
    }
    return;
  }

  _inflight.fetch_add(1, std::memory_order_acq_rel);
  CFRetain(sampleBuffer);
  dispatch_async(_queue, ^{
    @autoreleasepool {
      [self appendRetainedSampleBuffer:sampleBuffer];
      CFRelease(sampleBuffer);
      _inflight.fetch_sub(1, std::memory_order_acq_rel);
    }
  });
}

- (BOOL)finishSync:(NSError **)error {
  __block BOOL ok = YES;
  __block NSError *finishError = nil;
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

  dispatch_async(_queue, ^{
    @autoreleasepool {
      if (_finished) {
        dispatch_semaphore_signal(semaphore);
        return;
      }

      _finishing = YES;
      if (!_started || !_writer) {
        _finished = YES;
        dispatch_semaphore_signal(semaphore);
        return;
      }

      [_input markAsFinished];
      [_writer finishWritingWithCompletionHandler:^{
        if (_writer.status == AVAssetWriterStatusFailed ||
            _writer.status == AVAssetWriterStatusCancelled) {
          ok = NO;
          finishError = [_writer error] ?: MakeError(1005, @"Could not finish media writer");
          _error = finishError;
        }
        _finished = YES;
        dispatch_semaphore_signal(semaphore);
      }];
    }
  });

  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  if (!ok && error) {
    *error = finishError;
  }
  return ok;
}

- (void)cancel {
  dispatch_sync(_queue, ^{
    _finishing = YES;
    if (_writer && _writer.status == AVAssetWriterStatusWriting) {
      [_writer cancelWriting];
    }
    _finished = YES;
  });
  [[NSFileManager defaultManager] removeItemAtURL:_url error:nil];
}

@end

@interface RecorderSession : NSObject <SCStreamOutput,
                                       SCStreamDelegate,
                                       AVCaptureVideoDataOutputSampleBufferDelegate,
                                       AVCaptureAudioDataOutputSampleBufferDelegate>
- (instancetype)initWithOptions:(const RecordingOptions &)options;
- (BOOL)startSync:(NSError **)error;
- (BOOL)stopSync:(NSError **)error;
- (void)cancelSync;
- (NSDictionary *)startResult;
- (NSDictionary *)stopResult;
- (NSString *)sessionId;
- (NSString *)cameraDeviceId;
- (BOOL)attachPreviewOutput:(NSError **)error;
- (void)detachPreviewOutput;
@end

@implementation RecorderSession {
  RecordingOptions _options;
  NSURL *_outputDirectory;
  NSURL *_manifestURL;
  NSURL *_screenURL;
  NSURL *_cameraURL;
  NSURL *_systemAudioURL;
  NSURL *_microphoneURL;
  OSMediaFileWriter *_screenWriter;
  OSMediaFileWriter *_cameraWriter;
  OSMediaFileWriter *_systemAudioWriter;
  OSMediaFileWriter *_microphoneWriter;
  SCStream *_stream;
  AVCaptureSession *_cameraSession;
  AVCaptureVideoDataOutput *_cameraOutput;
  AVCaptureVideoDataOutput *_previewOutput;
  AVCaptureSession *_microphoneSession;
  AVCaptureAudioDataOutput *_microphoneOutput;
  dispatch_queue_t _screenQueue;
  dispatch_queue_t _systemAudioQueue;
  dispatch_queue_t _microphoneQueue;
  dispatch_queue_t _cameraQueue;
  dispatch_queue_t _previewQueue;
  NSDate *_startedAt;
  CMTime _hostStartTime;
  BOOL _running;
  BOOL _stopping;
  BOOL _usedScreenCaptureKitMicrophone;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _screenQueue = dispatch_queue_create("openscreen.sck.screen", DISPATCH_QUEUE_SERIAL);
    _systemAudioQueue = dispatch_queue_create("openscreen.sck.system-audio", DISPATCH_QUEUE_SERIAL);
    _microphoneQueue = dispatch_queue_create("openscreen.sck.microphone", DISPATCH_QUEUE_SERIAL);
    _cameraQueue = dispatch_queue_create("openscreen.av.camera", DISPATCH_QUEUE_SERIAL);
    _previewQueue = dispatch_queue_create("openscreen.av.camera-preview-tap", DISPATCH_QUEUE_SERIAL);
    _hostStartTime = kCMTimeInvalid;
  }
  return self;
}

- (NSString *)cameraDeviceId {
  return ToNSString(_options.cameraDeviceId);
}

- (BOOL)attachPreviewOutput:(NSError **)error {
  if (_previewOutput != nil) {
    return YES;
  }
  if (_cameraSession == nil) {
    if (error) *error = MakeError(2601, @"Cannot attach preview output: no camera session");
    return NO;
  }

  AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
  output.videoSettings = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
  };
  output.alwaysDiscardsLateVideoFrames = YES;
  [output setSampleBufferDelegate:self queue:_previewQueue];

  [_cameraSession beginConfiguration];
  if (![_cameraSession canAddOutput:output]) {
    [_cameraSession commitConfiguration];
    if (error) *error = MakeError(2602, @"Could not attach preview output to camera session");
    return NO;
  }
  [_cameraSession addOutput:output];
  AVCaptureConnection *connection = [output connectionWithMediaType:AVMediaTypeVideo];
  if (connection.isVideoMinFrameDurationSupported) {
    connection.videoMinFrameDuration = CMTimeMake(1, 30);
  }
  if (connection.isVideoMaxFrameDurationSupported) {
    connection.videoMaxFrameDuration = CMTimeMake(1, 30);
  }
  [_cameraSession commitConfiguration];
  _previewOutput = output;
  return YES;
}

- (void)detachPreviewOutput {
  if (_previewOutput == nil) return;
  AVCaptureVideoDataOutput *output = _previewOutput;
  _previewOutput = nil;
  [output setSampleBufferDelegate:nil queue:nil];
  if (_cameraSession) {
    [_cameraSession beginConfiguration];
    [_cameraSession removeOutput:output];
    [_cameraSession commitConfiguration];
  }
}

- (NSString *)sessionId {
  return ToNSString(_options.sessionId);
}

- (NSString *)fileNameForSource:(NSString *)source extension:(NSString *)extension {
  NSString *prefix = ToNSString(_options.basename);
  if (prefix.length == 0) {
    return [NSString stringWithFormat:@"%@.%@", source, extension];
  }
  return [NSString stringWithFormat:@"%@-%@.%@", prefix, source, extension];
}

- (BOOL)prepareOutputFiles:(NSError **)error {
  if (_options.outputDir.empty()) {
    if (error) {
      *error = MakeError(2001, @"startRecording requires outputDir");
    }
    return NO;
  }

  _outputDirectory = [NSURL fileURLWithPath:ToNSString(_options.outputDir)
                                isDirectory:YES];
  BOOL isDir = NO;
  NSFileManager *manager = [NSFileManager defaultManager];
  if (![manager fileExistsAtPath:[_outputDirectory path] isDirectory:&isDir]) {
    NSError *createError = nil;
    if (![manager createDirectoryAtURL:_outputDirectory
           withIntermediateDirectories:YES
                            attributes:nil
                                 error:&createError]) {
      if (error) {
        *error = createError;
      }
      return NO;
    }
  } else if (!isDir) {
    if (error) {
      *error = MakeError(2002, @"outputDir exists but is not a directory");
    }
    return NO;
  }

  _screenURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"screen" extension:@"mov"]];
  _cameraURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"camera" extension:@"mov"]];
  _systemAudioURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"system-audio" extension:@"m4a"]];
  _microphoneURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"microphone" extension:@"m4a"]];
  _manifestURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"recording" extension:@"json"]];

  _screenWriter = [[OSMediaFileWriter alloc] initWithURL:_screenURL
                                                  source:@"screen"
                                               mediaType:AVMediaTypeVideo
                                                fileType:AVFileTypeQuickTimeMovie];
  if (_options.recordSystemAudio) {
    _systemAudioWriter = [[OSMediaFileWriter alloc] initWithURL:_systemAudioURL
                                                         source:@"systemAudio"
                                                      mediaType:AVMediaTypeAudio
                                                       fileType:AVFileTypeAppleM4A];
  }
  if (_options.recordMicrophone) {
    _microphoneWriter = [[OSMediaFileWriter alloc] initWithURL:_microphoneURL
                                                        source:@"microphone"
                                                     mediaType:AVMediaTypeAudio
                                                      fileType:AVFileTypeAppleM4A];
  }
  if (_options.recordCamera) {
    _cameraWriter = [[OSMediaFileWriter alloc] initWithURL:_cameraURL
                                                    source:@"camera"
                                                 mediaType:AVMediaTypeVideo
                                                  fileType:AVFileTypeQuickTimeMovie];
  }
  return YES;
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

- (SCStreamConfiguration *)streamConfigurationForContent:(SCShareableContent *)content
                                                   filter:(SCContentFilter *)filter {
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

  if (@available(macOS 13.0, *)) {
    configuration.capturesAudio = _options.recordSystemAudio;
    configuration.sampleRate = 48000;
    configuration.channelCount = 2;
    configuration.excludesCurrentProcessAudio = YES;
  }

  if (@available(macOS 15.0, *)) {
    if (_options.recordMicrophone) {
      configuration.captureMicrophone = YES;
      if (!_options.microphoneDeviceId.empty()) {
        configuration.microphoneCaptureDeviceID = ToNSString(_options.microphoneDeviceId);
      }
      _usedScreenCaptureKitMicrophone = YES;
    }
  }

  return configuration;
}

- (AVCaptureDevice *)deviceWithUniqueID:(const std::string &)uniqueID
                              mediaType:(AVMediaType)mediaType {
  if (!uniqueID.empty()) {
    AVCaptureDevice *device =
        [AVCaptureDevice deviceWithUniqueID:ToNSString(uniqueID)];
    if (device) {
      return device;
    }
  }
  return [AVCaptureDevice defaultDeviceWithMediaType:mediaType];
}

- (BOOL)setupCameraCapture:(NSError **)error {
  if (!_options.recordCamera) {
    return YES;
  }

  AVCaptureDevice *device = [self deviceWithUniqueID:_options.cameraDeviceId
                                           mediaType:AVMediaTypeVideo];
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

  _cameraSession = [[AVCaptureSession alloc] init];
  _cameraSession.sessionPreset = AVCaptureSessionPresetHigh;
  [_cameraSession beginConfiguration];
  if ([_cameraSession canAddInput:input]) {
    [_cameraSession addInput:input];
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
  if ([_cameraSession canAddOutput:_cameraOutput]) {
    [_cameraSession addOutput:_cameraOutput];
  } else {
    if (error) {
      *error = MakeError(2304, @"Could not add camera output");
    }
    return NO;
  }
  [_cameraSession commitConfiguration];
  return YES;
}

- (BOOL)setupMicrophoneFallback:(NSError **)error {
  if (!_options.recordMicrophone || _usedScreenCaptureKitMicrophone) {
    return YES;
  }

  AVCaptureDevice *device = [self deviceWithUniqueID:_options.microphoneDeviceId
                                           mediaType:AVMediaTypeAudio];
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

  _microphoneSession = [[AVCaptureSession alloc] init];
  [_microphoneSession beginConfiguration];
  if ([_microphoneSession canAddInput:input]) {
    [_microphoneSession addInput:input];
  } else {
    if (error) {
      *error = MakeError(2403, @"Could not add microphone input");
    }
    return NO;
  }

  _microphoneOutput = [[AVCaptureAudioDataOutput alloc] init];
  [_microphoneOutput setSampleBufferDelegate:self queue:_microphoneQueue];
  if ([_microphoneSession canAddOutput:_microphoneOutput]) {
    [_microphoneSession addOutput:_microphoneOutput];
  } else {
    if (error) {
      *error = MakeError(2404, @"Could not add microphone output");
    }
    return NO;
  }
  [_microphoneSession commitConfiguration];
  return YES;
}

- (void)teardownPartialStart {
  // Reverses anything -startSync may have already started. Safe to call
  // multiple times and from any failure branch below; AVCaptureSession's
  // stopRunning is a no-op when the session never started.
  if (_cameraSession) {
    [_cameraSession stopRunning];
  }
  if (_microphoneSession) {
    [_microphoneSession stopRunning];
  }
  // Cancel any writer that might have created an empty .mov/.m4a stub on
  // disk before the failure. cancel is idempotent.
  [_screenWriter cancel];
  [_cameraWriter cancel];
  [_systemAudioWriter cancel];
  [_microphoneWriter cancel];
  _stream = nil;
  _cameraSession = nil;
  _cameraOutput = nil;
  _microphoneSession = nil;
  _microphoneOutput = nil;
  _running = NO;
}

- (BOOL)startSync:(NSError **)error {
  @autoreleasepool {
    if (![self prepareOutputFiles:error]) {
      [self teardownPartialStart];
      return NO;
    }

    SCShareableContent *content = nil;
    if (![self getShareableContent:&content error:error]) {
      [self teardownPartialStart];
      return NO;
    }

    SCContentFilter *filter = [self contentFilterFromContent:content error:error];
    if (!filter) {
      [self teardownPartialStart];
      return NO;
    }

    SCStreamConfiguration *configuration =
        [self streamConfigurationForContent:content filter:filter];

    if (![self setupCameraCapture:error]) {
      [self teardownPartialStart];
      return NO;
    }
    if (![self setupMicrophoneFallback:error]) {
      [self teardownPartialStart];
      return NO;
    }

    _stream = [[SCStream alloc] initWithFilter:filter
                                  configuration:configuration
                                      delegate:self];

    NSError *addOutputError = nil;
    if (![_stream addStreamOutput:self
                             type:SCStreamOutputTypeScreen
               sampleHandlerQueue:_screenQueue
                            error:&addOutputError]) {
      if (error) {
        *error = addOutputError ?: MakeError(2501, @"Could not add screen stream output");
      }
      [self teardownPartialStart];
      return NO;
    }

    if (_options.recordSystemAudio) {
      if (![_stream addStreamOutput:self
                               type:SCStreamOutputTypeAudio
                 sampleHandlerQueue:_systemAudioQueue
                              error:&addOutputError]) {
        if (error) {
          *error = addOutputError ?: MakeError(2502, @"Could not add system audio output");
        }
        [self teardownPartialStart];
        return NO;
      }
    }

    if (_usedScreenCaptureKitMicrophone) {
      if (@available(macOS 15.0, *)) {
        if (![_stream addStreamOutput:self
                                 type:SCStreamOutputTypeMicrophone
                   sampleHandlerQueue:_microphoneQueue
                                error:&addOutputError]) {
          if (error) {
            *error = addOutputError ?: MakeError(2503, @"Could not add microphone output");
          }
          [self teardownPartialStart];
          return NO;
        }
      }
    }

    _startedAt = [NSDate date];
    _hostStartTime = CMClockGetTime(CMClockGetHostTimeClock());
    _running = YES;

    if (_cameraSession) {
      [_cameraSession startRunning];
    }
    if (_microphoneSession) {
      [_microphoneSession startRunning];
    }

    __block NSError *startError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [_stream startCaptureWithCompletionHandler:^(NSError *streamError) {
      startError = streamError;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

    if (startError) {
      if (error) {
        *error = startError;
      }
      // The capture sessions for camera/microphone are already running at
      // this point — leaving them running would keep the camera LED on and
      // pin the audio device after we report failure. Stop them explicitly
      // instead of relying on ARC to clean up eventually.
      [self teardownPartialStart];
      return NO;
    }

    EmitEvent({"started", _options.sessionId, "", "", 0});

    SetActiveRecorder(self);
    [self adoptPendingPreviewIfMatching];

    return YES;
  }
}

- (void)adoptPendingPreviewIfMatching {
  std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
  if (_cameraSession == nil) return;
  NSString *deviceId = [self cameraDeviceId];
  if (deviceId.length == 0) return;

  OSCameraPreviewSession *standalone = nil;
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    if (!gPreviewCallback) return;
    if (gPreviewDeviceId.length == 0 || ![gPreviewDeviceId isEqualToString:deviceId]) {
      return;
    }
    standalone = gPreviewSession;
    gPreviewSession = nil;
  }

  [standalone stop];

  NSError *attachError = nil;
  if ([self attachPreviewOutput:&attachError]) {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    gPreviewHostRecorder = self;
    return;
  }

  std::lock_guard<std::mutex> lock(gPreviewMutex);
  if (gPreviewCallback) {
    gPreviewCallback->Release();
    gPreviewCallback.reset();
  }
  gPreviewDeviceId = nil;
}

- (void)releasePreviewOnStop {
  std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
  NSString *handBackDeviceId = nil;
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    if (gPreviewHostRecorder == self) {
      gPreviewHostRecorder = nil;
      if (gPreviewCallback && gPreviewDeviceId.length > 0) {
        handBackDeviceId = [gPreviewDeviceId copy];
      }
    }
  }

  [self detachPreviewOutput];

  if (handBackDeviceId.length == 0) return;

  OSCameraPreviewSession *replacement =
      [[OSCameraPreviewSession alloc] initWithDeviceId:handBackDeviceId];
  NSError *replaceError = nil;
  if ([replacement startWithError:&replaceError]) {
    BOOL keep = NO;
    {
      std::lock_guard<std::mutex> lock(gPreviewMutex);
      // The TSFN may have been torn down between the time we took the device
      // id above and now. If it's gone, throw away the new session too — the
      // consumer has already moved on.
      if (gPreviewCallback) {
        gPreviewSession = replacement;
        keep = YES;
      }
    }
    if (!keep) {
      [replacement stop];
    }
    return;
  }

  // Replacement failed to start. We can no longer deliver frames; clear the
  // preview state so the TSFN doesn't sit around forever waiting for frames
  // that will never arrive, and drop the pooled buffers that targeted it.
  EmitEvent({"error", "", "cameraPreview",
             ToStdString([replaceError localizedDescription]
                             ?: @"Camera preview could not be rehanded after recording stopped"),
             0});
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    if (gPreviewCallback) {
      gPreviewCallback->Release();
      gPreviewCallback.reset();
    }
    gPreviewDeviceId = nil;
  }
  ClearPreviewPool();
}

- (BOOL)stopSync:(NSError **)error {
  @autoreleasepool {
    if (!_running && !_stream) {
      return YES;
    }

    _stopping = YES;
    ClearActiveRecorder(self);

    __block NSError *streamStopError = nil;
    if (_stream) {
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      [_stream stopCaptureWithCompletionHandler:^(NSError *stopError) {
        streamStopError = stopError;
        dispatch_semaphore_signal(semaphore);
      }];
      dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    }

    if (_cameraSession) {
      [_cameraSession stopRunning];
    }
    [self releasePreviewOnStop];
    if (_microphoneSession) {
      [_microphoneSession stopRunning];
    }

    NSMutableArray<NSError *> *finishErrors = [NSMutableArray array];
    for (OSMediaFileWriter *writer in @[
           _screenWriter ?: (OSMediaFileWriter *)[NSNull null],
           _cameraWriter ?: (OSMediaFileWriter *)[NSNull null],
           _systemAudioWriter ?: (OSMediaFileWriter *)[NSNull null],
           _microphoneWriter ?: (OSMediaFileWriter *)[NSNull null],
         ]) {
      if ((id)writer == [NSNull null]) {
        continue;
      }
      NSError *finishError = nil;
      if (![writer finishSync:&finishError] && finishError) {
        [finishErrors addObject:finishError];
      }
    }

    _running = NO;
    [self writeManifest];

    if (streamStopError || finishErrors.count > 0) {
      if (error) {
        *error = streamStopError ?: [finishErrors firstObject];
      }
      return NO;
    }

    EmitEvent({"stopped", _options.sessionId, "", "", 0});
    return YES;
  }
}

- (void)cancelSync {
  _stopping = YES;
  ClearActiveRecorder(self);
  if (_stream) {
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [_stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  }
  [_cameraSession stopRunning];
  [self releasePreviewOnStop];
  [_microphoneSession stopRunning];
  [_screenWriter cancel];
  [_cameraWriter cancel];
  [_systemAudioWriter cancel];
  [_microphoneWriter cancel];
  [[NSFileManager defaultManager] removeItemAtURL:_manifestURL error:nil];
  _running = NO;
  EmitEvent({"cancelled", _options.sessionId, "", "", 0});
}

- (NSDictionary *)filesDictionary {
  NSMutableDictionary *files = [NSMutableDictionary dictionary];
  files[@"screen"] = [_screenURL path];
  if (_cameraWriter) {
    files[@"camera"] = [_cameraURL path];
  }
  if (_systemAudioWriter) {
    files[@"systemAudio"] = [_systemAudioURL path];
  }
  if (_microphoneWriter) {
    files[@"microphone"] = [_microphoneURL path];
  }
  files[@"manifest"] = [_manifestURL path];
  return files;
}

- (NSDictionary *)targetDictionary {
  NSMutableDictionary *target = [NSMutableDictionary dictionary];
  target[@"type"] = ToNSString(_options.target.type);
  if (_options.target.displayId) {
    target[@"displayId"] = @(_options.target.displayId);
  }
  if (_options.target.windowId) {
    target[@"windowId"] = @(_options.target.windowId);
  }
  if (!_options.target.bundleId.empty()) {
    target[@"bundleId"] = ToNSString(_options.target.bundleId);
  }
  return target;
}

- (NSArray *)writerMetadata {
  NSMutableArray *outputs = [NSMutableArray array];
  for (OSMediaFileWriter *writer in @[
         _screenWriter ?: (OSMediaFileWriter *)[NSNull null],
         _cameraWriter ?: (OSMediaFileWriter *)[NSNull null],
         _systemAudioWriter ?: (OSMediaFileWriter *)[NSNull null],
         _microphoneWriter ?: (OSMediaFileWriter *)[NSNull null],
       ]) {
    if ((id)writer != [NSNull null]) {
      [outputs addObject:[writer metadata]];
    }
  }
  return outputs;
}

- (NSDictionary *)manifestDictionary {
  NSTimeInterval startedMs = [_startedAt timeIntervalSince1970] * 1000.0;
  NSMutableDictionary *manifest = [NSMutableDictionary dictionary];
  manifest[@"sessionId"] = ToNSString(_options.sessionId);
  manifest[@"startedAtUnixMs"] = @(startedMs);
  manifest[@"hostStartMs"] = @(TimeToMilliseconds(_hostStartTime));
  manifest[@"target"] = [self targetDictionary];
  manifest[@"fps"] = @(_options.fps);
  manifest[@"includeCursor"] = @(_options.includeCursor);
  manifest[@"excludeOwnApp"] = @(_options.excludeOwnApp);
  manifest[@"files"] = [self filesDictionary];
  manifest[@"outputs"] = [self writerMetadata];
  manifest[@"microphoneSource"] =
      _usedScreenCaptureKitMicrophone ? @"screenCaptureKit" : @"avFoundation";
  if (!_options.cameraDeviceId.empty()) {
    manifest[@"cameraDeviceId"] = ToNSString(_options.cameraDeviceId);
  }
  if (!_options.microphoneDeviceId.empty()) {
    manifest[@"microphoneDeviceId"] = ToNSString(_options.microphoneDeviceId);
  }
  return manifest;
}

- (void)writeManifest {
  NSDictionary *manifest = [self manifestDictionary];
  NSError *jsonError = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:manifest
                                                 options:NSJSONWritingPrettyPrinted
                                                   error:&jsonError];
  if (data && !jsonError) {
    [data writeToURL:_manifestURL atomically:YES];
  }
}

- (NSDictionary *)startResult {
  return @{
    @"sessionId" : ToNSString(_options.sessionId),
    @"files" : [self filesDictionary],
  };
}

- (NSDictionary *)stopResult {
  return @{
    @"sessionId" : ToNSString(_options.sessionId),
    @"files" : [self filesDictionary],
    @"manifest" : [self manifestDictionary],
  };
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

  if (type == SCStreamOutputTypeScreen) {
    if ([self isCompleteScreenFrame:sampleBuffer]) {
      [_screenWriter appendSampleBuffer:sampleBuffer];
    }
  } else if (@available(macOS 13.0, *)) {
    if (type == SCStreamOutputTypeAudio) {
      [_systemAudioWriter appendSampleBuffer:sampleBuffer];
    } else if (@available(macOS 15.0, *)) {
      if (type == SCStreamOutputTypeMicrophone) {
        [_microphoneWriter appendSampleBuffer:sampleBuffer];
      }
    }
  }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  if (error) {
    EmitEvent({"error", _options.sessionId, "screen", ToStdString([error localizedDescription]), 0});
  }
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (_stopping || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }

  if (output == _cameraOutput) {
    [_cameraWriter appendSampleBuffer:sampleBuffer];
  } else if (output == _previewOutput) {
    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (pixelBuffer) {
      DeliverPreviewFrame(pixelBuffer);
    }
  } else if (output == _microphoneOutput) {
    [_microphoneWriter appendSampleBuffer:sampleBuffer];
  }
}

@end

static void DeliverPreviewFrame(CVPixelBufferRef pixelBuffer) {
  if (!pixelBuffer) {
    NSLog(@"[cameraPreview/native] DeliverPreviewFrame: pixelBuffer is nil");
    return;
  }
  if (CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
    NSLog(@"[cameraPreview/native] DeliverPreviewFrame: LockBaseAddress failed");
    return;
  }
  NSLog(@"[cameraPreview/native] DeliverPreviewFrame: locked pixelBuffer");

  size_t width = CVPixelBufferGetWidth(pixelBuffer);
  size_t height = CVPixelBufferGetHeight(pixelBuffer);
  size_t srcRowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer);
  uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
  const size_t needed = width * height * 4;

  std::unique_ptr<CameraPreviewFrame> frame = AcquirePreviewFrame();
  frame->width = (int)width;
  frame->height = (int)height;
  frame->rowBytes = (int)(width * 4);
  if (frame->data.size() != needed) {
    frame->data.resize(needed);
  }

  // BGRA -> RGBA via vImage SIMD permute; also drops any row padding.
  vImage_Buffer src = {
    .data = base,
    .height = (vImagePixelCount)height,
    .width = (vImagePixelCount)width,
    .rowBytes = srcRowBytes,
  };
  vImage_Buffer dst = {
    .data = frame->data.data(),
    .height = (vImagePixelCount)height,
    .width = (vImagePixelCount)width,
    .rowBytes = width * 4,
  };
  const uint8_t permute[4] = {2, 1, 0, 3};
  vImagePermuteChannels_ARGB8888(&src, &dst, permute, kvImageNoFlags);

  CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
  NSLog(@"[cameraPreview/native] DeliverPreviewFrame: unlocked, width=%zu height=%zu", width, height);

  CameraPreviewFrame *raw = nullptr;
  napi_status status = napi_closing;
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    if (!gPreviewCallback) {
      NSLog(@"[cameraPreview/native] DeliverPreviewFrame: no gPreviewCallback, dropping frame");
      // No consumer; return the buffer to the pool and bail.
      RecyclePreviewFrame(std::move(frame));
      return;
    }
    raw = frame.release();
    status = gPreviewCallback->NonBlockingCall(
        raw,
        [](Napi::Env env, Napi::Function callback, CameraPreviewFrame *f) {
          Napi::HandleScope scope(env);
          // Hand the underlying buffer to V8 without copying. The finalizer
          // (run when V8 GCs the Buffer) returns the frame object — vector
          // and all — to the pool so subsequent frames reuse the allocation.
          Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(
              env,
              f->data.data(),
              f->data.size(),
              [](Napi::Env /*env*/, uint8_t * /*data*/, CameraPreviewFrame *hint) {
                RecyclePreviewFrame(std::unique_ptr<CameraPreviewFrame>(hint));
              },
              f);
          Napi::Object obj = Napi::Object::New(env);
          obj.Set("width", Napi::Number::New(env, f->width));
          obj.Set("height", Napi::Number::New(env, f->height));
          obj.Set("rowBytes", Napi::Number::New(env, f->rowBytes));
          obj.Set("data", buf);
          callback.Call({obj});
          ClearPendingPreviewException(env);
          // Ownership of `f` now lives in the Buffer finalizer; do not delete.
        });
    NSLog(@"[cameraPreview/native] DeliverPreviewFrame: NonBlockingCall status=%d", (int)status);
  }
  if (status != napi_ok && raw != nullptr) {
    // Queue was full or TSFN was closing — recycle so we don't leak.
    NSLog(@"[cameraPreview/native] DeliverPreviewFrame: TSFN call failed, recycling frame");
    RecyclePreviewFrame(std::unique_ptr<CameraPreviewFrame>(raw));
  }
}

@implementation OSCameraPreviewSession {
  NSString *_deviceId;
  AVCaptureSession *_session;
  AVCaptureVideoDataOutput *_output;
  dispatch_queue_t _queue;
  std::atomic<bool> _running;
}

- (instancetype)initWithDeviceId:(NSString *)deviceId {
  self = [super init];
  if (self) {
    _deviceId = [deviceId copy];
    _queue = dispatch_queue_create("openscreen.camera.preview", DISPATCH_QUEUE_SERIAL);
    _running = false;
  }
  return self;
}

- (BOOL)startWithError:(NSError **)error {
  AVCaptureDevice *device = nil;
  if (_deviceId.length > 0) {
    device = [AVCaptureDevice deviceWithUniqueID:_deviceId];
  }
  if (!device) {
    device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  }
  if (!device) {
    if (error) *error = MakeError(2501, @"No camera device available for preview");
    return NO;
  }

  NSError *inputError = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
  if (!input) {
    if (error) *error = inputError ?: MakeError(2502, @"Could not create camera preview input");
    return NO;
  }

  _session = [[AVCaptureSession alloc] init];
  if ([_session canSetSessionPreset:AVCaptureSessionPreset640x480]) {
    _session.sessionPreset = AVCaptureSessionPreset640x480;
  } else {
    _session.sessionPreset = AVCaptureSessionPresetMedium;
  }
  [_session beginConfiguration];
  if (![_session canAddInput:input]) {
    [_session commitConfiguration];
    if (error) *error = MakeError(2503, @"Could not add camera preview input");
    return NO;
  }
  [_session addInput:input];

  _output = [[AVCaptureVideoDataOutput alloc] init];
  _output.videoSettings = @{
    (NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
  };
  _output.alwaysDiscardsLateVideoFrames = YES;
  [_output setSampleBufferDelegate:self queue:_queue];
  if (![_session canAddOutput:_output]) {
    [_session commitConfiguration];
    if (error) *error = MakeError(2504, @"Could not add camera preview output");
    return NO;
  }
  [_session addOutput:_output];

  AVCaptureConnection *connection = [_output connectionWithMediaType:AVMediaTypeVideo];
  if (connection.isVideoMinFrameDurationSupported) {
    connection.videoMinFrameDuration = CMTimeMake(1, 30);
  }
  if (connection.isVideoMaxFrameDurationSupported) {
    connection.videoMaxFrameDuration = CMTimeMake(1, 30);
  }
  [_session commitConfiguration];

  _running = true;
  [_session startRunning];
  return YES;
}

- (void)stop {
  if (!_running.exchange(false)) return;
  [_session stopRunning];
  if (_output) {
    [_output setSampleBufferDelegate:nil queue:nil];
  }
  _output = nil;
  _session = nil;
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (!_running.load()) {
    NSLog(@"[cameraPreview/native] captureOutput called but not running");
    return;
  }
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  NSLog(@"[cameraPreview/native] captureOutput got pixelBuffer %p", pixelBuffer);
  DeliverPreviewFrame(pixelBuffer);
}

@end

static void StopCameraPreviewInternal() {
  OSCameraPreviewSession *toStop = nil;
  RecorderSession *hostToDetach = nil;
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    toStop = gPreviewSession;
    gPreviewSession = nil;
    hostToDetach = gPreviewHostRecorder;
    gPreviewHostRecorder = nil;
    gPreviewDeviceId = nil;
    if (gPreviewCallback) {
      gPreviewCallback->Release();
      gPreviewCallback.reset();
    }
  }
  [toStop stop];
  [hostToDetach detachPreviewOutput];
  // After stop there is no consumer for pooled buffers — free them so they
  // don't sit in memory until the next preview starts.
  ClearPreviewPool();
}

static NSMutableDictionary<NSString *, RecorderSession *> *SessionStore() {
  static NSMutableDictionary<NSString *, RecorderSession *> *store;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    store = [[NSMutableDictionary alloc] init];
  });
  return store;
}

static void StoreSession(RecorderSession *session) {
  @synchronized(SessionStore()) {
    SessionStore()[[session sessionId]] = session;
  }
}

static RecorderSession *GetSession(const std::string &sessionId) {
  @synchronized(SessionStore()) {
    return SessionStore()[ToNSString(sessionId)];
  }
}

static void RemoveSession(const std::string &sessionId) {
  @synchronized(SessionStore()) {
    [SessionStore() removeObjectForKey:ToNSString(sessionId)];
  }
}

class PromiseWorker : public Napi::AsyncWorker {
 public:
  explicit PromiseWorker(Napi::Env env)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

 protected:
  Napi::Promise::Deferred deferred_;
};

class StartCameraPreviewWorker final : public PromiseWorker {
 public:
  StartCameraPreviewWorker(
      Napi::Env env,
      std::string deviceId,
      Napi::ThreadSafeFunction tsfn,
      uint64_t generation)
      : PromiseWorker(env),
        deviceId_(std::move(deviceId)),
        tsfn_(tsfn),
        generation_(generation) {}

  void Execute() override {
    @autoreleasepool {
      std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
      if (!IsCurrentPreviewGeneration(generation_)) {
        return;
      }

      StopCameraPreviewInternal();
      if (!IsCurrentPreviewGeneration(generation_)) {
        return;
      }

      NSString *requestedDeviceId = ToNSString(deviceId_);
      RecorderSession *activeRecorder = ActiveRecorderForPreview();
      BOOL hostOnRecorder = activeRecorder != nil &&
          requestedDeviceId.length > 0 &&
          [[activeRecorder cameraDeviceId] isEqualToString:requestedDeviceId];

      if (hostOnRecorder) {
        NSError *attachError = nil;
        if (![activeRecorder attachPreviewOutput:&attachError]) {
          failed_ = true;
          errorMessage_ = ToStdString(
              attachError.localizedDescription ?: @"Failed to attach preview to recorder");
          return;
        }

        {
          std::lock_guard<std::mutex> lock(gPreviewMutex);
          if (gPreviewGeneration == generation_) {
            gPreviewCallback = std::make_unique<Napi::ThreadSafeFunction>(tsfn_);
            gPreviewDeviceId = [requestedDeviceId copy];
            gPreviewHostRecorder = activeRecorder;
            published_ = true;
          }
        }
        if (!published_) {
          [activeRecorder detachPreviewOutput];
        }
        return;
      }

      OSCameraPreviewSession *session =
          [[OSCameraPreviewSession alloc] initWithDeviceId:requestedDeviceId];
      NSError *startError = nil;
      if (![session startWithError:&startError]) {
        failed_ = true;
        errorMessage_ = ToStdString(
            startError.localizedDescription ?: @"Failed to start camera preview");
        return;
      }

      {
        std::lock_guard<std::mutex> lock(gPreviewMutex);
        if (gPreviewGeneration == generation_) {
          gPreviewCallback = std::make_unique<Napi::ThreadSafeFunction>(tsfn_);
          gPreviewSession = session;
          gPreviewDeviceId = [requestedDeviceId copy];
          published_ = true;
        }
      }

      if (!published_) {
        [session stop];
      }
    }
  }

  void OnOK() override {
    if (!published_) {
      tsfn_.Release();
    }
    if (failed_) {
      deferred_.Reject(Napi::Error::New(Env(), errorMessage_).Value());
      return;
    }
    deferred_.Resolve(Env().Undefined());
  }

 private:
  std::string deviceId_;
  Napi::ThreadSafeFunction tsfn_;
  uint64_t generation_;
  bool failed_ = false;
  bool published_ = false;
  std::string errorMessage_;
};

class StopCameraPreviewWorker final : public PromiseWorker {
 public:
  StopCameraPreviewWorker(Napi::Env env, uint64_t generation)
      : PromiseWorker(env), generation_(generation) {}

  void Execute() override {
    @autoreleasepool {
      std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
      if (IsCurrentPreviewGeneration(generation_)) {
        StopCameraPreviewInternal();
      }
    }
  }

  void OnOK() override {
    deferred_.Resolve(Env().Undefined());
  }

 private:
  uint64_t generation_;
};

static Napi::Object NSDictionaryToNapi(Napi::Env env, NSDictionary *dictionary);

static Napi::Value NSObjectToNapi(Napi::Env env, id value) {
  if (!value || value == [NSNull null]) {
    return env.Null();
  }
  if ([value isKindOfClass:[NSString class]]) {
    return Napi::String::New(env, ToStdString((NSString *)value));
  }
  if ([value isKindOfClass:[NSNumber class]]) {
    const char *type = [(NSNumber *)value objCType];
    if (strcmp(type, @encode(BOOL)) == 0) {
      return Napi::Boolean::New(env, [(NSNumber *)value boolValue]);
    }
    return Napi::Number::New(env, [(NSNumber *)value doubleValue]);
  }
  if ([value isKindOfClass:[NSDictionary class]]) {
    return NSDictionaryToNapi(env, (NSDictionary *)value);
  }
  if ([value isKindOfClass:[NSArray class]]) {
    NSArray *array = (NSArray *)value;
    Napi::Array result = Napi::Array::New(env, array.count);
    for (NSUInteger i = 0; i < array.count; ++i) {
      result.Set((uint32_t)i, NSObjectToNapi(env, array[i]));
    }
    return result;
  }
  return Napi::String::New(env, ToStdString([value description]));
}

static Napi::Object NSDictionaryToNapi(Napi::Env env, NSDictionary *dictionary) {
  Napi::Object object = Napi::Object::New(env);
  for (id key in dictionary) {
    object.Set(ToStdString([key description]), NSObjectToNapi(env, dictionary[key]));
  }
  return object;
}

class StartRecordingWorker final : public PromiseWorker {
 public:
  StartRecordingWorker(Napi::Env env, const std::string &sessionId)
      : PromiseWorker(env), sessionId_(sessionId) {}

  void Execute() override {
    @autoreleasepool {
      RecorderSession *session = GetSession(sessionId_);
      if (!session) {
        failed_ = true;
        errorMessage_ = "Recording session was not found";
        return;
      }
      NSError *error = nil;
      if (![session startSync:&error]) {
        failed_ = true;
        errorMessage_ = ToStdString([error localizedDescription]);
      }
    }
  }

  void OnOK() override {
    if (failed_) {
      RemoveSession(sessionId_);
      deferred_.Reject(Napi::Error::New(Env(), errorMessage_).Value());
      return;
    }
    RecorderSession *session = GetSession(sessionId_);
    if (!session) {
      deferred_.Reject(Napi::Error::New(Env(), "Recording session was not found").Value());
      return;
    }
    deferred_.Resolve(NSDictionaryToNapi(Env(), [session startResult]));
  }

 private:
  std::string sessionId_;
  bool failed_ = false;
  std::string errorMessage_;
};

class StopRecordingWorker final : public PromiseWorker {
 public:
  StopRecordingWorker(Napi::Env env, const std::string &sessionId)
      : PromiseWorker(env), sessionId_(sessionId) {}

  void Execute() override {
    @autoreleasepool {
      RecorderSession *session = GetSession(sessionId_);
      if (!session) {
        SetError("Recording session was not found");
        return;
      }
      NSError *error = nil;
      if (![session stopSync:&error]) {
        SetError(ToStdString([error localizedDescription]));
      }
    }
  }

  void OnOK() override {
    RecorderSession *session = GetSession(sessionId_);
    if (!session) {
      deferred_.Reject(Napi::Error::New(Env(), "Recording session was not found").Value());
      return;
    }
    NSDictionary *result = [session stopResult];
    RemoveSession(sessionId_);
    deferred_.Resolve(NSDictionaryToNapi(Env(), result));
  }

 private:
  std::string sessionId_;
};

class CancelRecordingWorker final : public PromiseWorker {
 public:
  CancelRecordingWorker(Napi::Env env, const std::string &sessionId)
      : PromiseWorker(env), sessionId_(sessionId) {}

  void Execute() override {
    @autoreleasepool {
      RecorderSession *session = GetSession(sessionId_);
      if (!session) {
        return;
      }
      [session cancelSync];
      RemoveSession(sessionId_);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }

 private:
  std::string sessionId_;
};

class RequestPermissionsWorker final : public PromiseWorker {
 public:
  RequestPermissionsWorker(Napi::Env env, std::vector<std::string> kinds)
      : PromiseWorker(env), kinds_(std::move(kinds)) {}

  void Execute() override {
    @autoreleasepool {
      for (const std::string &kind : kinds_) {
        if (kind == "screen" || kind == "systemAudio") {
          CGRequestScreenCaptureAccess();
        } else if (kind == "camera") {
          RequestAVAccess(AVMediaTypeVideo);
        } else if (kind == "microphone") {
          RequestAVAccess(AVMediaTypeAudio);
        }
      }
    }
  }

  void OnOK() override { deferred_.Resolve(GetPermissionsObject(Env())); }

 private:
  void RequestAVAccess(AVMediaType mediaType) {
    if ([AVCaptureDevice authorizationStatusForMediaType:mediaType] !=
        AVAuthorizationStatusNotDetermined) {
      return;
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:mediaType
                             completionHandler:^(__unused BOOL granted) {
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  }

  static Napi::Object GetPermissionsObject(Napi::Env env);

  std::vector<std::string> kinds_;
};

class ListShareableContentWorker final : public PromiseWorker {
 public:
  explicit ListShareableContentWorker(Napi::Env env) : PromiseWorker(env) {}

  void Execute() override {
    @autoreleasepool {
      __block NSError *error = nil;
      __block SCShareableContent *content = nil;
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                                 onScreenWindowsOnly:YES
                                                   completionHandler:^(SCShareableContent *shareableContent,
                                                                       NSError *shareableError) {
        content = shareableContent;
        error = shareableError;
        dispatch_semaphore_signal(semaphore);
      }];
      dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

      if (!content || error) {
        SetError(ToStdString([error localizedDescription]));
        return;
      }

      for (SCDisplay *display in content.displays) {
        DisplayInfo info;
        info.id = display.displayID;
        info.width = display.width;
        info.height = display.height;
        info.x = display.frame.origin.x;
        info.y = display.frame.origin.y;
        displays_.push_back(info);
      }

      for (SCWindow *window in content.windows) {
        WindowInfo info;
        info.id = window.windowID;
        info.title = ToStdString(window.title);
        info.onScreen = window.isOnScreen;
        info.x = window.frame.origin.x;
        info.y = window.frame.origin.y;
        info.width = window.frame.size.width;
        info.height = window.frame.size.height;
        if (window.owningApplication) {
          info.appName = ToStdString(window.owningApplication.applicationName);
          info.bundleId = ToStdString(window.owningApplication.bundleIdentifier);
          info.pid = window.owningApplication.processID;
        }
        windows_.push_back(info);
      }

      for (SCRunningApplication *app in content.applications) {
        AppInfo info;
        info.name = ToStdString(app.applicationName);
        info.bundleId = ToStdString(app.bundleIdentifier);
        info.pid = app.processID;
        apps_.push_back(info);
      }
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);

    Napi::Array displays = Napi::Array::New(env, displays_.size());
    for (size_t i = 0; i < displays_.size(); ++i) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("displayId", displays_[i].id);
      item.Set("width", (double)displays_[i].width);
      item.Set("height", (double)displays_[i].height);
      item.Set("x", displays_[i].x);
      item.Set("y", displays_[i].y);
      displays.Set((uint32_t)i, item);
    }

    Napi::Array windows = Napi::Array::New(env, windows_.size());
    for (size_t i = 0; i < windows_.size(); ++i) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("windowId", windows_[i].id);
      item.Set("title", windows_[i].title);
      item.Set("applicationName", windows_[i].appName);
      item.Set("bundleId", windows_[i].bundleId);
      item.Set("processId", windows_[i].pid);
      item.Set("onScreen", windows_[i].onScreen);
      item.Set("x", windows_[i].x);
      item.Set("y", windows_[i].y);
      item.Set("width", windows_[i].width);
      item.Set("height", windows_[i].height);
      windows.Set((uint32_t)i, item);
    }

    Napi::Array apps = Napi::Array::New(env, apps_.size());
    for (size_t i = 0; i < apps_.size(); ++i) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("applicationName", apps_[i].name);
      item.Set("bundleId", apps_[i].bundleId);
      item.Set("processId", apps_[i].pid);
      apps.Set((uint32_t)i, item);
    }

    result.Set("displays", displays);
    result.Set("windows", windows);
    result.Set("applications", apps);
    deferred_.Resolve(result);
  }

 private:
  std::vector<DisplayInfo> displays_;
  std::vector<WindowInfo> windows_;
  std::vector<AppInfo> apps_;
};

static Napi::Object GetPermissionsObjectImpl(Napi::Env env) {
  Napi::Object permissions = Napi::Object::New(env);
  bool screenGranted = CGPreflightScreenCaptureAccess();
  permissions.Set("screen", screenGranted ? "granted" : "notDetermined");
  permissions.Set("systemAudio", screenGranted ? "granted" : "notDetermined");
  permissions.Set("camera",
                  PermissionState([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]));
  permissions.Set("microphone",
                  PermissionState([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]));
  return permissions;
}

Napi::Object RequestPermissionsWorker::GetPermissionsObject(Napi::Env env) {
  return GetPermissionsObjectImpl(env);
}

static RecordingOptions ParseRecordingOptions(const Napi::CallbackInfo &info) {
  RecordingOptions options;
  options.sessionId = NewSessionId();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return options;
  }

  Napi::Object object = info[0].As<Napi::Object>();
  options.outputDir = GetStringProp(object, "outputDir");
  options.basename = GetStringProp(object, "basename");
  options.fps = GetIntProp(object, "fps", 30);
  if (options.fps != 60) {
    options.fps = 30;
  }
  options.width = GetIntProp(object, "width", 0);
  options.height = GetIntProp(object, "height", 0);
  options.includeCursor = GetBoolProp(object, "includeCursor", true);
  options.recordSystemAudio = GetBoolProp(object, "recordSystemAudio", true);
  options.recordMicrophone = GetBoolProp(object, "recordMicrophone", false);
  options.recordCamera = GetBoolProp(object, "recordCamera", false);
  options.excludeOwnApp = GetBoolProp(object, "excludeOwnApp", true);
  options.microphoneDeviceId = GetStringProp(object, "microphoneDeviceId");
  options.cameraDeviceId = GetStringProp(object, "cameraDeviceId");

  Napi::Value targetValue = object.Get("target");
  if (targetValue.IsObject()) {
    Napi::Object target = targetValue.As<Napi::Object>();
    options.target.type = GetStringProp(target, "type", "display");
    options.target.displayId = GetUint32Prop(target, "displayId", 0);
    options.target.windowId = GetUint32Prop(target, "windowId", 0);
    options.target.bundleId = GetStringProp(target, "bundleId");
  }

  return options;
}

static Napi::Value Hello(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), "Hello, World from macOS native addon!");
}

static Napi::Value GetCapabilities(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  NSOperatingSystemVersion version =
      [[NSProcessInfo processInfo] operatingSystemVersion];
  Napi::Object result = Napi::Object::New(env);
  result.Set("platform", "darwin");
  result.Set("macosVersion", [NSString stringWithFormat:@"%ld.%ld.%ld",
                              (long)version.majorVersion,
                              (long)version.minorVersion,
                              (long)version.patchVersion].UTF8String);
  result.Set("screenCaptureKit", IsMacOSAtLeast(13));
  result.Set("systemAudio", IsMacOSAtLeast(13));
  result.Set("screenCaptureKitMicrophone", IsMacOSAtLeast(15));
  result.Set("microphoneFallback", true);
  result.Set("camera", true);
  result.Set("separateFiles", true);
  result.Set("scRecordingOutput", IsMacOSAtLeast(15));
  return result;
}

static Napi::Value GetPermissions(const Napi::CallbackInfo &info) {
  return GetPermissionsObjectImpl(info.Env());
}

static Napi::Value RequestPermissions(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::vector<std::string> kinds;

  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array array = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < array.Length(); ++i) {
      Napi::Value value = array.Get(i);
      if (value.IsString()) {
        kinds.push_back(value.As<Napi::String>().Utf8Value());
      }
    }
  }

  auto *worker = new RequestPermissionsWorker(env, std::move(kinds));
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value ListShareableContent(const Napi::CallbackInfo &info) {
  auto *worker = new ListShareableContentWorker(info.Env());
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value ListDevices(const Napi::CallbackInfo &info, AVMediaType mediaType) {
  Napi::Env env = info.Env();
  NSArray<AVCaptureDevice *> *devices = @[];
  NSMutableArray<AVCaptureDeviceType> *deviceTypes = [NSMutableArray array];
  AVCaptureDevice *defaultDevice =
      [AVCaptureDevice defaultDeviceWithMediaType:mediaType];

  if ([mediaType isEqualToString:AVMediaTypeVideo]) {
    [deviceTypes addObject:AVCaptureDeviceTypeBuiltInWideAngleCamera];
    [deviceTypes addObject:AVCaptureDeviceTypeDeskViewCamera];
    if (@available(macOS 14.0, *)) {
      [deviceTypes addObject:AVCaptureDeviceTypeExternal];
      [deviceTypes addObject:AVCaptureDeviceTypeContinuityCamera];
    }
  } else if ([mediaType isEqualToString:AVMediaTypeAudio]) {
    if (@available(macOS 14.0, *)) {
      [deviceTypes addObject:AVCaptureDeviceTypeMicrophone];
    } else {
      devices = defaultDevice ? @[ defaultDevice ] : @[];
    }
  }

  if (deviceTypes.count > 0) {
    AVCaptureDeviceDiscoverySession *session =
        [AVCaptureDeviceDiscoverySession
            discoverySessionWithDeviceTypes:deviceTypes
                                  mediaType:mediaType
                                   position:AVCaptureDevicePositionUnspecified];
    devices = session.devices;
  }

  Napi::Array result = Napi::Array::New(env, devices.count);
  for (NSUInteger i = 0; i < devices.count; ++i) {
    AVCaptureDevice *device = devices[i];
    Napi::Object item = Napi::Object::New(env);
    item.Set("deviceId", ToStdString(device.uniqueID));
    item.Set("uniqueID", ToStdString(device.uniqueID));
    item.Set("localizedName", ToStdString(device.localizedName));
    item.Set("manufacturer", ToStdString(device.manufacturer));
    item.Set("modelID", ToStdString(device.modelID));
    item.Set("deviceType", ToStdString(device.deviceType));
    item.Set("connected", device.isConnected);
    item.Set("suspended", device.isSuspended);
    item.Set("inUseByAnotherApplication", device.isInUseByAnotherApplication);
    item.Set("position", (int)device.position);
    item.Set("isDefault",
             defaultDevice != nil &&
                 [device.uniqueID isEqualToString:defaultDevice.uniqueID]);
    result.Set((uint32_t)i, item);
  }
  return result;
}

static Napi::Value ListCameras(const Napi::CallbackInfo &info) {
  return ListDevices(info, AVMediaTypeVideo);
}

static Napi::Value ListMicrophones(const Napi::CallbackInfo &info) {
  return ListDevices(info, AVMediaTypeAudio);
}

static Napi::Value StartRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  RecordingOptions options = ParseRecordingOptions(info);

  auto reject = [&](const std::string &message) {
    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, message).Value());
    return deferred.Promise();
  };

  if (options.outputDir.empty()) {
    return reject("startRecording requires outputDir");
  }

  BOOL isDirectory = NO;
  NSString *outputPath = ToNSString(options.outputDir);
  if ([[NSFileManager defaultManager] fileExistsAtPath:outputPath
                                           isDirectory:&isDirectory] &&
      !isDirectory) {
    return reject("outputDir exists but is not a directory");
  }

  if (!CGPreflightScreenCaptureAccess()) {
    return reject("Screen Recording permission is not granted");
  }

  if (options.recordCamera &&
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo] !=
          AVAuthorizationStatusAuthorized) {
    return reject("Camera permission is not granted");
  }

  if (options.recordMicrophone &&
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] !=
          AVAuthorizationStatusAuthorized) {
    return reject("Microphone permission is not granted");
  }

  RecorderSession *session = [[RecorderSession alloc] initWithOptions:options];
  StoreSession(session);

  auto *worker = new StartRecordingWorker(env, options.sessionId);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value StopRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string sessionId;
  if (info.Length() > 0 && info[0].IsString()) {
    sessionId = info[0].As<Napi::String>().Utf8Value();
  }
  auto *worker = new StopRecordingWorker(env, sessionId);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value CancelRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string sessionId;
  if (info.Length() > 0 && info[0].IsString()) {
    sessionId = info[0].As<Napi::String>().Utf8Value();
  }
  auto *worker = new CancelRecordingWorker(env, sessionId);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value OnRecordingEvent(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "onRecordingEvent requires a callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::lock_guard<std::mutex> lock(gEventMutex);
  if (gEventCallback) {
    gEventCallback->Release();
    gEventCallback.reset();
  }

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env,
      info[0].As<Napi::Function>(),
      "OpenScreenRecordingEvent",
      256,
      1);
  gEventCallback = std::make_unique<Napi::ThreadSafeFunction>(tsfn);

  return Napi::Function::New(env, [](const Napi::CallbackInfo &callbackInfo) {
    std::lock_guard<std::mutex> unsubscribeLock(gEventMutex);
    if (gEventCallback) {
      gEventCallback->Release();
      gEventCallback.reset();
    }
    return callbackInfo.Env().Undefined();
  });
}

static Napi::Value StartCameraPreview(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startCameraPreview(options, callback) requires an options object and a callback")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo] !=
      AVAuthorizationStatusAuthorized) {
    Napi::Error::New(env, "Camera permission is not granted").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object options = info[0].As<Napi::Object>();
  std::string deviceId = GetStringProp(options, "deviceId");

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "OpenScreenCameraPreview", 4, 1);

  auto *worker = new StartCameraPreviewWorker(
      env, std::move(deviceId), tsfn, NextPreviewGeneration());
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Value StopCameraPreview(const Napi::CallbackInfo &info) {
  auto *worker = new StopCameraPreviewWorker(info.Env(), NextPreviewGeneration());
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("hello", Napi::Function::New(env, Hello));
  exports.Set("getCapabilities", Napi::Function::New(env, GetCapabilities));
  exports.Set("getPermissions", Napi::Function::New(env, GetPermissions));
  exports.Set("requestPermissions", Napi::Function::New(env, RequestPermissions));
  exports.Set("listShareableContent", Napi::Function::New(env, ListShareableContent));
  exports.Set("listCameras", Napi::Function::New(env, ListCameras));
  exports.Set("listMicrophones", Napi::Function::New(env, ListMicrophones));
  exports.Set("startRecording", Napi::Function::New(env, StartRecording));
  exports.Set("stopRecording", Napi::Function::New(env, StopRecording));
  exports.Set("cancelRecording", Napi::Function::New(env, CancelRecording));
  exports.Set("onRecordingEvent", Napi::Function::New(env, OnRecordingEvent));
  exports.Set("startCameraPreview", Napi::Function::New(env, StartCameraPreview));
  exports.Set("stopCameraPreview", Napi::Function::New(env, StopCameraPreview));
  return exports;
}

NODE_API_MODULE(mac_addon, Init)
