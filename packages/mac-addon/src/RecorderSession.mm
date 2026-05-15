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
  BOOL _paused;
}

- (instancetype)initWithOptions:(const RecordingOptions &)options {
  self = [super init];
  if (self) {
    _options = options;
    _screen = [[ScreenTrack alloc] initWithOptions:options
                                          sessionId:ToNSString(options.sessionId)];
    _camera = [[CameraTrack alloc] initWithOptions:options];
    _systemAudio = [[SystemAudioTrack alloc] initWithOptions:options screenTrack:_screen];
    _microphone = [[MicrophoneTrack alloc] initWithOptions:options screenTrack:_screen];
    _hostStartTime = kCMTimeInvalid;
  }
  return self;
}

- (NSString *)sessionId      { return ToNSString(_options.sessionId); }
- (NSString *)cameraDeviceId { return [_camera deviceId]; }

- (BOOL)attachPreviewOutput:(NSError **)error {
  return [_camera attachPreviewOutput:error];
}
- (void)detachPreviewOutput { [_camera detachPreviewOutput]; }

- (NSString *)fileNameForSource:(NSString *)source extension:(NSString *)extension {
  NSString *prefix = ToNSString(_options.basename);
  if (prefix.length == 0) {
    return [NSString stringWithFormat:@"%@.%@", source, extension];
  }
  return [NSString stringWithFormat:@"%@-%@.%@", prefix, source, extension];
}

- (BOOL)prepareOutputFiles:(NSError **)error {
  if (_options.outputDir.empty()) {
    if (error) *error = MakeError(2001, @"startRecording requires outputDir");
    return NO;
  }

  _outputDirectory = [NSURL fileURLWithPath:ToNSString(_options.outputDir) isDirectory:YES];
  BOOL isDir = NO;
  NSFileManager *manager = [NSFileManager defaultManager];
  if (![manager fileExistsAtPath:[_outputDirectory path] isDirectory:&isDir]) {
    NSError *createError = nil;
    if (![manager createDirectoryAtURL:_outputDirectory
           withIntermediateDirectories:YES
                            attributes:nil
                                 error:&createError]) {
      if (error) *error = createError;
      return NO;
    }
  } else if (!isDir) {
    if (error) *error = MakeError(2002, @"outputDir exists but is not a directory");
    return NO;
  }

  [_screen setOutputURL:[_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"screen" extension:@"mov"]]];
  [_camera setOutputURL:[_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"camera" extension:@"mov"]]];
  _manifestURL = [_outputDirectory URLByAppendingPathComponent:
      [self fileNameForSource:@"recording" extension:@"json"]];

  [_camera prepareWriter];
  return YES;
}

- (void)teardownPartialStart {
  if ([_camera hasCaptureSession]) [_camera stopCapture];
  [_screen cancelWriter];
  [_camera cancelWriter];
  _stream = nil;
  [_camera resetCapture];
  NSURL *screenURL = [_screen url];
  if (screenURL) {
    [[NSFileManager defaultManager] removeItemAtURL:screenURL error:nil];
  }
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

    // Build the configuration first — that resolves dimensions and codec,
    // which the writer needs.
    SCStreamConfiguration *configuration = [_screen streamConfigurationForContent:content];
    [_systemAudio configureSCStreamConfig:configuration];
    [_microphone configureSCStreamConfig:configuration];

    if (![_screen prepareWriter:error]) {
      [self teardownPartialStart];
      return NO;
    }
    if ([_systemAudio isEnabled]) {
      if (![_screen addSystemAudioInput:error]) {
        [self teardownPartialStart];
        return NO;
      }
    }
    if ([_microphone isEnabled]) {
      if (![_screen addMicrophoneInput:error]) {
        [self teardownPartialStart];
        return NO;
      }
    }

    if (![_camera setupAVCaptureSession:error]) {
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
    if (![_microphone addToStream:_stream error:error]) {
      [self teardownPartialStart];
      return NO;
    }

    _startedAt = [NSDate date];
    _hostStartTime = CMClockGetTime(CMClockGetHostTimeClock());
    _running = YES;

    if ([_camera hasCaptureSession]) [_camera startCapture];

    __block NSError *startError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [_stream startCaptureWithCompletionHandler:^(NSError *streamError) {
      startError = streamError;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

    if (startError) {
      if (error) *error = startError;
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
    if (!_running && !_stream) return YES;

    _stopping = YES;
    [_screen markStopping];
    [_camera markStopping];
    [_systemAudio markStopping];
    [_microphone markStopping];
    ClearActiveRecorder(self);

    __block NSError *streamStopError = nil;
    if (_stream) {
      // Bound the wait: SCKit's stopCapture completion has been observed to
      // hang indefinitely when the system audio stack is wedged. Time out
      // after 10s so the JS state machine can transition out of "stopping"
      // and surface an error to the user instead of leaving the UI frozen.
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      [_stream stopCaptureWithCompletionHandler:^(NSError *stopError) {
        streamStopError = stopError;
        dispatch_semaphore_signal(semaphore);
      }];
      dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC);
      if (dispatch_semaphore_wait(semaphore, deadline) != 0) {
        streamStopError =
            MakeError(2403, @"ScreenCaptureKit stopCapture did not complete within 10s");
        EmitEvent({"error", _options.sessionId, "screen",
                   ToStdString([streamStopError localizedDescription]), 0});
      }
    }

    if ([_camera hasCaptureSession]) [_camera stopCapture];
    ReleasePreviewForRecorderOnStop(self);

    NSError *screenFinishError = nil;
    BOOL screenOk = [_screen finishWriterSync:&screenFinishError];
    NSError *cameraFinishError = nil;
    BOOL cameraOk = [_camera finishWriterSync:&cameraFinishError];

    _running = NO;
    [self writeManifest];

    if (streamStopError || !screenOk || !cameraOk) {
      if (error) {
        *error = streamStopError ?: screenFinishError ?: cameraFinishError;
      }
      return NO;
    }

    EmitEvent({"stopped", _options.sessionId, "", "", 0});
    return YES;
  }
}

- (BOOL)pauseSync:(NSError **)error {
  if (!_running) {
    if (error) *error = MakeError(2401, @"Cannot pause: no recording in progress");
    return NO;
  }
  if (_stopping) {
    if (error) *error = MakeError(2402, @"Cannot pause: recording is stopping");
    return NO;
  }
  if (_paused) return YES;
  _paused = YES;
  [_screen setPaused:YES];
  [_camera setPaused:YES];
  EmitEvent({"paused", _options.sessionId, "", "", 0});
  return YES;
}

- (BOOL)resumeSync:(NSError **)error {
  if (!_running) {
    if (error) *error = MakeError(2403, @"Cannot resume: no recording in progress");
    return NO;
  }
  if (_stopping) {
    if (error) *error = MakeError(2404, @"Cannot resume: recording is stopping");
    return NO;
  }
  if (!_paused) return YES;
  [_screen setPaused:NO];
  [_camera setPaused:NO];
  _paused = NO;
  EmitEvent({"resumed", _options.sessionId, "", "", 0});
  return YES;
}

- (BOOL)isPaused {
  return _paused;
}

- (double)pausedMs {
  CMTime paused = [_screen pauseAccumulated];
  return TimeToMilliseconds(paused);
}

- (void)cancelSync {
  _stopping = YES;
  [_screen markStopping];
  [_camera markStopping];
  [_systemAudio markStopping];
  [_microphone markStopping];
  ClearActiveRecorder(self);
  if (_stream) {
    // Mirror the 10s deadline used in -stopSync. SCKit's stopCapture has been
    // observed to hang indefinitely on a wedged audio stack; without the
    // bound, the JS state machine sits in 'stopping' forever and the user
    // has to force-quit to recover.
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [_stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC);
    if (dispatch_semaphore_wait(semaphore, deadline) != 0) {
      EmitEvent({"error", _options.sessionId, "screen",
                 "ScreenCaptureKit stopCapture did not complete within 10s during cancel",
                 0});
    }
  }
  [_camera stopCapture];
  ReleasePreviewForRecorderOnStop(self);
  [_screen cancelWriter];
  [_camera cancelWriter];
  // Both URLs may be nil if cancelSync runs before -prepareOutputFiles
  // populated them (e.g., a start that failed inside SCKit setup, then a
  // cancel from the JS state machine). -removeItemAtURL:nil raises
  // NSInvalidArgumentException, which would crash the addon thread.
  NSURL *screenUrl = [_screen url];
  if (screenUrl) {
    [[NSFileManager defaultManager] removeItemAtURL:screenUrl error:nil];
  }
  if (_manifestURL) {
    [[NSFileManager defaultManager] removeItemAtURL:_manifestURL error:nil];
  }
  _running = NO;
  EmitEvent({"cancelled", _options.sessionId, "", "", 0});
}

- (NSDictionary *)filesDictionary {
  NSMutableDictionary *files = [NSMutableDictionary dictionary];
  files[@"screen"] = [[_screen url] path];
  if ([_camera hasWriter]) {
    files[@"camera"] = [[_camera url] path];
  }
  files[@"manifest"] = [_manifestURL path];
  return files;
}

- (NSDictionary *)targetDictionary {
  NSMutableDictionary *target = [NSMutableDictionary dictionary];
  target[@"type"] = ToNSString(_options.target.type);
  if (_options.target.displayId) target[@"displayId"] = @(_options.target.displayId);
  if (_options.target.windowId)  target[@"windowId"]  = @(_options.target.windowId);
  if (!_options.target.bundleId.empty()) {
    target[@"bundleId"] = ToNSString(_options.target.bundleId);
  }
  if (!_options.target.title.empty()) {
    target[@"title"] = ToNSString(_options.target.title);
  }
  if (!_options.target.applicationName.empty()) {
    target[@"applicationName"] = ToNSString(_options.target.applicationName);
  }
  if (_options.target.processId) {
    target[@"processId"] = @(_options.target.processId);
  }
  if (_options.target.width > 0 && _options.target.height > 0) {
    target[@"x"] = @(_options.target.x);
    target[@"y"] = @(_options.target.y);
    target[@"width"] = @(_options.target.width);
    target[@"height"] = @(_options.target.height);
  }
  if (_options.target.sourceWidth > 0 && _options.target.sourceHeight > 0) {
    target[@"sourceX"] = @(_options.target.sourceX);
    target[@"sourceY"] = @(_options.target.sourceY);
    target[@"sourceWidth"] = @(_options.target.sourceWidth);
    target[@"sourceHeight"] = @(_options.target.sourceHeight);
  }
  if (_options.target.scaleFactor > 0) {
    target[@"scaleFactor"] = @(_options.target.scaleFactor);
  }
  return target;
}

- (NSArray *)writerMetadata {
  NSMutableArray *outputs = [NSMutableArray array];
  NSDictionary *screenMeta = [_screen metadata];
  if (screenMeta) [outputs addObject:screenMeta];
  NSDictionary *cameraMeta = [_camera writerMetadata];
  if (cameraMeta) [outputs addObject:cameraMeta];
  NSDictionary *systemAudioMeta = [_systemAudio metadata];
  if (systemAudioMeta) [outputs addObject:systemAudioMeta];
  NSDictionary *microphoneMeta = [_microphone metadata];
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
  manifest[@"microphoneSource"] = @"screenCaptureKit";
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
    EmitEvent({"error", _options.sessionId, "screen",
               ToStdString([error localizedDescription]), 0});
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
