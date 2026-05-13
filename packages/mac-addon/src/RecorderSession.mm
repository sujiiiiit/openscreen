#include "RecorderSession.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include "CameraPreview.h"
#include "CameraTrack.h"
#include "Events.h"
#include "MicrophoneTrack.h"
#include "ScreenTrack.h"
#include "SystemAudioTrack.h"

@implementation RecorderSession {
  RecordingOptions _options;
  NSURL *_outputDirectory;
  NSURL *_manifestURL;
  ScreenTrack *_screen;
  CameraTrack *_camera;
  SystemAudioTrack *_systemAudio;
  MicrophoneTrack *_microphone;
  SCStream *_stream;
  NSDate *_startedAt;
  CMTime _hostStartTime;
  BOOL _running;
  BOOL _stopping;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _screen = [[ScreenTrack alloc] initWithOptions:options];
    _camera = [[CameraTrack alloc] initWithOptions:options];
    _systemAudio = [[SystemAudioTrack alloc] initWithOptions:options];
    _microphone = [[MicrophoneTrack alloc] initWithOptions:options];
    _hostStartTime = kCMTimeInvalid;
  }
  return self;
}

- (NSString *)sessionId {
  return ToNSString(_options.sessionId);
}

- (NSString *)cameraDeviceId {
  return [_camera deviceId];
}

- (BOOL)attachPreviewOutput:(NSError **)error {
  return [_camera attachPreviewOutput:error];
}

- (void)detachPreviewOutput {
  [_camera detachPreviewOutput];
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

  [_screen setOutputURL:[_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"screen" extension:@"mov"]]];
  [_camera setOutputURL:[_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"camera" extension:@"mov"]]];
  [_systemAudio setOutputURL:[_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"system-audio" extension:@"m4a"]]];
  [_microphone setOutputURL:[_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"microphone" extension:@"m4a"]]];
  _manifestURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"recording" extension:@"json"]];

  [_screen prepareWriter];
  [_systemAudio prepareWriter];
  [_microphone prepareWriter];
  [_camera prepareWriter];
  return YES;
}

- (void)teardownPartialStart {
  // Reverses anything -startSync may have already started. Safe to call
  // multiple times and from any failure branch below; AVCaptureSession's
  // stopRunning is a no-op when the session never started.
  if ([_camera hasCaptureSession]) {
    [_camera stopCapture];
  }
  [_microphone stopFallback];
  // Cancel any writer that might have created an empty .mov/.m4a stub on
  // disk before the failure. cancel is idempotent.
  [_screen cancelWriter];
  [_camera cancelWriter];
  [_systemAudio cancelWriter];
  [_microphone cancelWriter];
  _stream = nil;
  [_camera resetCapture];
  [_microphone resetFallback];
  _running = NO;
}

- (BOOL)startSync:(NSError **)error {
  @autoreleasepool {
    if (![self prepareOutputFiles:error]) {
      [self teardownPartialStart];
      return NO;
    }

    SCShareableContent *content = nil;
    if (![_screen getShareableContent:&content error:error]) {
      [self teardownPartialStart];
      return NO;
    }

    SCContentFilter *filter = [_screen contentFilterFromContent:content error:error];
    if (!filter) {
      [self teardownPartialStart];
      return NO;
    }

    SCStreamConfiguration *configuration =
        [_screen streamConfigurationForContent:content];
    [_systemAudio configureSCStreamConfig:configuration];
    [_microphone configureSCStreamConfig:configuration];

    if (![_camera setupAVCaptureSession:error]) {
      [self teardownPartialStart];
      return NO;
    }
    if (![_microphone setupFallbackIfNeeded:error]) {
      [self teardownPartialStart];
      return NO;
    }

    _stream = [[SCStream alloc] initWithFilter:filter
                                  configuration:configuration
                                      delegate:self];

    if (![_screen addToStream:_stream error:error]) {
      [self teardownPartialStart];
      return NO;
    }
    if (![_systemAudio addToStream:_stream error:error]) {
      [self teardownPartialStart];
      return NO;
    }
    if (![_microphone addSCKitOutputToStream:_stream error:error]) {
      [self teardownPartialStart];
      return NO;
    }

    _startedAt = [NSDate date];
    _hostStartTime = CMClockGetTime(CMClockGetHostTimeClock());
    _running = YES;

    if ([_camera hasCaptureSession]) {
      [_camera startCapture];
    }
    [_microphone startFallback];

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
    AdoptPendingPreviewForRecorder(self);

    return YES;
  }
}

- (BOOL)stopSync:(NSError **)error {
  @autoreleasepool {
    if (!_running && !_stream) {
      return YES;
    }

    _stopping = YES;
    [_screen markStopping];
    [_camera markStopping];
    [_systemAudio markStopping];
    [_microphone markStopping];
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

    if ([_camera hasCaptureSession]) {
      [_camera stopCapture];
    }
    ReleasePreviewForRecorderOnStop(self);
    [_microphone stopFallback];

    NSMutableArray<NSError *> *finishErrors = [NSMutableArray array];
    for (id<NSObject> trackObj in @[ _screen, _camera, _systemAudio, _microphone ]) {
      NSError *finishError = nil;
      BOOL ok = YES;
      if (trackObj == _screen) {
        ok = [_screen finishWriterSync:&finishError];
      } else if (trackObj == _camera) {
        ok = [_camera finishWriterSync:&finishError];
      } else if (trackObj == _systemAudio) {
        ok = [_systemAudio finishWriterSync:&finishError];
      } else if (trackObj == _microphone) {
        ok = [_microphone finishWriterSync:&finishError];
      }
      if (!ok && finishError) {
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
  [_screen markStopping];
  [_camera markStopping];
  [_systemAudio markStopping];
  [_microphone markStopping];
  ClearActiveRecorder(self);
  if (_stream) {
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [_stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  }
  [_camera stopCapture];
  ReleasePreviewForRecorderOnStop(self);
  [_microphone stopFallback];
  [_screen cancelWriter];
  [_camera cancelWriter];
  [_systemAudio cancelWriter];
  [_microphone cancelWriter];
  [[NSFileManager defaultManager] removeItemAtURL:_manifestURL error:nil];
  _running = NO;
  EmitEvent({"cancelled", _options.sessionId, "", "", 0});
}

- (NSDictionary *)filesDictionary {
  NSMutableDictionary *files = [NSMutableDictionary dictionary];
  files[@"screen"] = [[_screen url] path];
  if ([_camera hasWriter]) {
    files[@"camera"] = [[_camera url] path];
  }
  if ([_systemAudio hasWriter]) {
    files[@"systemAudio"] = [[_systemAudio url] path];
  }
  if ([_microphone hasWriter]) {
    files[@"microphone"] = [[_microphone url] path];
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
  NSDictionary *screenMeta = [_screen writerMetadata];
  if (screenMeta) [outputs addObject:screenMeta];
  NSDictionary *cameraMeta = [_camera writerMetadata];
  if (cameraMeta) [outputs addObject:cameraMeta];
  NSDictionary *systemAudioMeta = [_systemAudio writerMetadata];
  if (systemAudioMeta) [outputs addObject:systemAudioMeta];
  NSDictionary *microphoneMeta = [_microphone writerMetadata];
  if (microphoneMeta) [outputs addObject:microphoneMeta];
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
      [_microphone usesScreenCaptureKit] ? @"screenCaptureKit" : @"avFoundation";
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

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  if (error) {
    EmitEvent({"error", _options.sessionId, "screen", ToStdString([error localizedDescription]), 0});
  }
}

@end

static NSMutableDictionary<NSString *, RecorderSession *> *SessionStore() {
  static NSMutableDictionary<NSString *, RecorderSession *> *store;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    store = [[NSMutableDictionary alloc] init];
  });
  return store;
}

void StoreSession(RecorderSession *session) {
  @synchronized(SessionStore()) {
    SessionStore()[[session sessionId]] = session;
  }
}

RecorderSession *GetSession(const std::string &sessionId) {
  @synchronized(SessionStore()) {
    return SessionStore()[ToNSString(sessionId)];
  }
}

void RemoveSession(const std::string &sessionId) {
  @synchronized(SessionStore()) {
    [SessionStore() removeObjectForKey:ToNSString(sessionId)];
  }
}
