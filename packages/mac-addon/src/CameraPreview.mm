#include "CameraPreview.h"

#import <Accelerate/Accelerate.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

#include "Common.h"
#include "Events.h"
#include "RecorderSession.h"

namespace {

struct CameraPreviewFrame {
  std::vector<uint8_t> data;
  int width = 0;
  int height = 0;
  int rowBytes = 0;
};

std::mutex gPreviewMutex;
std::mutex gPreviewOperationMutex;
std::unique_ptr<Napi::ThreadSafeFunction> gPreviewCallback;
NSString *gPreviewDeviceId = nil;
__weak RecorderSession *gPreviewHostRecorder = nil;
__weak RecorderSession *gActiveRecorder = nil;
OSCameraPreviewSession *gPreviewSession = nil;
uint64_t gPreviewGeneration = 0;
std::atomic<bool> gPreviewCallbackExceptionLogged(false);

// Free-list of reusable preview frame buffers. Bounded so we don't pin large
// vectors after the preview stops; surplus frames are dropped at recycle time.
std::mutex gPreviewPoolMutex;
std::vector<std::unique_ptr<CameraPreviewFrame>> gPreviewPool;
constexpr size_t kPreviewPoolCap = 6;

std::unique_ptr<CameraPreviewFrame> AcquirePreviewFrame() {
  std::lock_guard<std::mutex> lock(gPreviewPoolMutex);
  if (gPreviewPool.empty()) {
    return std::unique_ptr<CameraPreviewFrame>(new CameraPreviewFrame());
  }
  std::unique_ptr<CameraPreviewFrame> frame = std::move(gPreviewPool.back());
  gPreviewPool.pop_back();
  return frame;
}

void RecyclePreviewFrame(std::unique_ptr<CameraPreviewFrame> frame) {
  if (!frame) return;
  std::lock_guard<std::mutex> lock(gPreviewPoolMutex);
  if (gPreviewPool.size() < kPreviewPoolCap) {
    gPreviewPool.push_back(std::move(frame));
  }
}

void ClearPreviewPool() {
  std::lock_guard<std::mutex> lock(gPreviewPoolMutex);
  gPreviewPool.clear();
}

void ClearPendingPreviewException(Napi::Env env) {
  if (!env.IsExceptionPending()) return;

  Napi::Error error = env.GetAndClearPendingException();
  if (!gPreviewCallbackExceptionLogged.exchange(true, std::memory_order_relaxed)) {
    EmitEvent({"error", "", "cameraPreview", error.Message(), 0});
  }
}

}  // namespace

uint64_t NextPreviewGeneration() {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  gPreviewCallbackExceptionLogged.store(false, std::memory_order_relaxed);
  return ++gPreviewGeneration;
}

BOOL IsCurrentPreviewGeneration(uint64_t generation) {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  return gPreviewGeneration == generation;
}

RecorderSession *ActiveRecorderForPreview() {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  return gActiveRecorder;
}

void SetActiveRecorder(RecorderSession *recorder) {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  gActiveRecorder = recorder;
}

void ClearActiveRecorder(RecorderSession *recorder) {
  std::lock_guard<std::mutex> lock(gPreviewMutex);
  if (gActiveRecorder == recorder) {
    gActiveRecorder = nil;
  }
}

void DeliverPreviewFrame(CVPixelBufferRef pixelBuffer) {
  if (!pixelBuffer) return;
  if (CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
    return;
  }

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

  CameraPreviewFrame *raw = nullptr;
  napi_status status = napi_closing;
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    if (!gPreviewCallback) {
      RecyclePreviewFrame(std::move(frame));
      return;
    }
    raw = frame.release();
    status = gPreviewCallback->NonBlockingCall(
        raw,
        [](Napi::Env env, Napi::Function callback, CameraPreviewFrame *f) {
          std::unique_ptr<CameraPreviewFrame> owned(f);
          Napi::HandleScope scope(env);

          // Node 22+ rejects external buffers. Copy into a V8-owned buffer
          // and recycle the source frame immediately.
          Napi::Buffer<uint8_t> buf =
              Napi::Buffer<uint8_t>::Copy(env, owned->data.data(), owned->data.size());
          if (env.IsExceptionPending()) {
            ClearPendingPreviewException(env);
            RecyclePreviewFrame(std::move(owned));
            return;
          }

          Napi::Object obj = Napi::Object::New(env);
          obj.Set("width", Napi::Number::New(env, owned->width));
          obj.Set("height", Napi::Number::New(env, owned->height));
          obj.Set("rowBytes", Napi::Number::New(env, owned->rowBytes));
          obj.Set("data", buf);

          callback.Call({obj});
          ClearPendingPreviewException(env);
          RecyclePreviewFrame(std::move(owned));
        });
  }
  if (status != napi_ok && raw != nullptr) {
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

  [_session commitConfiguration];

  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserver:self
         selector:@selector(handleSessionRuntimeError:)
             name:AVCaptureSessionRuntimeErrorNotification
           object:_session];
  [nc addObserver:self
         selector:@selector(handleSessionInterrupted:)
             name:AVCaptureSessionWasInterruptedNotification
           object:_session];

  _running = true;
  [_session startRunning];
  return YES;
}

- (void)stop {
  if (!_running.exchange(false)) return;
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [_session stopRunning];
  if (_output) {
    [_output setSampleBufferDelegate:nil queue:nil];
  }
  _output = nil;
  _session = nil;
}

- (void)handleSessionRuntimeError:(NSNotification *)note {
  NSError *err = note.userInfo[AVCaptureSessionErrorKey];
  NSString *msg = err.localizedDescription ?: @"unknown runtime error";
  EmitEvent({"error", "", "cameraPreview", ToStdString(msg), 0});
}

- (void)handleSessionInterrupted:(NSNotification *)note {
  (void)note;
  EmitEvent({"error", "", "cameraPreview", "Camera capture interrupted", 0});
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (!_running.load()) return;
  DeliverPreviewFrame(CMSampleBufferGetImageBuffer(sampleBuffer));
}

@end

void StopCameraPreviewInternal() {
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

void AdoptPendingPreviewForRecorder(RecorderSession *recorder) {
  std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
  NSString *deviceId = [recorder cameraDeviceId];
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
  if ([recorder attachPreviewOutput:&attachError]) {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    gPreviewHostRecorder = recorder;
    return;
  }

  std::lock_guard<std::mutex> lock(gPreviewMutex);
  if (gPreviewCallback) {
    gPreviewCallback->Release();
    gPreviewCallback.reset();
  }
  gPreviewDeviceId = nil;
}

void ReleasePreviewForRecorderOnStop(RecorderSession *recorder) {
  std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
  NSString *handBackDeviceId = nil;
  {
    std::lock_guard<std::mutex> lock(gPreviewMutex);
    if (gPreviewHostRecorder == recorder) {
      gPreviewHostRecorder = nil;
      if (gPreviewCallback && gPreviewDeviceId.length > 0) {
        handBackDeviceId = [gPreviewDeviceId copy];
      }
    }
  }

  [recorder detachPreviewOutput];

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

StartCameraPreviewWorker::StartCameraPreviewWorker(
    Napi::Env env,
    std::string deviceId,
    Napi::ThreadSafeFunction tsfn,
    uint64_t generation)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      deviceId_(std::move(deviceId)),
      tsfn_(tsfn),
      generation_(generation) {}

void StartCameraPreviewWorker::Execute() {
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

void StartCameraPreviewWorker::OnOK() {
  if (!published_) {
    tsfn_.Release();
  }
  if (failed_) {
    deferred_.Reject(Napi::Error::New(Env(), errorMessage_).Value());
    return;
  }
  deferred_.Resolve(Env().Undefined());
}

StopCameraPreviewWorker::StopCameraPreviewWorker(Napi::Env env, uint64_t generation)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      generation_(generation) {}

void StopCameraPreviewWorker::Execute() {
  @autoreleasepool {
    std::lock_guard<std::mutex> operationLock(gPreviewOperationMutex);
    if (IsCurrentPreviewGeneration(generation_)) {
      StopCameraPreviewInternal();
    }
  }
}
