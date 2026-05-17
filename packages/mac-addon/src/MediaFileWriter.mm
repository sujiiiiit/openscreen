#include "MediaFileWriter.h"

#import <AudioToolbox/AudioToolbox.h>

#include <atomic>
#include <cstdint>
#include <vector>

#include "Common.h"
#include "Events.h"

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
  // Set once -createWriterForSampleBuffer: returns NO. Without this guard,
  // every subsequent sample re-enters the failed init path: removeItemAtURL,
  // alloc/init AVAssetWriter, failure, EmitEvent — flooding the JS event bus
  // with hundreds of identical "error" events per second until the recorder
  // is stopped.
  BOOL _writerCreationFailed;
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
  // Pause / resume. _paused is atomic so the producer (appendSampleBuffer:)
  // can short-circuit before retaining the sample buffer. _pauseAccumulated
  // and _pauseStartHost are only read/written on _queue (serial) so they
  // don't need synchronization.
  std::atomic<bool> _paused;
  CMTime _pauseStartHost;
  CMTime _pauseAccumulated;
  NSInteger _pauseCycleCount;
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
    _paused.store(false, std::memory_order_relaxed);
    _pauseStartHost = kCMTimeInvalid;
    _pauseAccumulated = kCMTimeZero;
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
    if (_pauseCycleCount > 0) {
      metadata[@"pauseCycles"] = @(_pauseCycleCount);
    }
    CMTime totalPaused = _pauseAccumulated;
    if (_paused.load(std::memory_order_relaxed) && CMTIME_IS_VALID(_pauseStartHost)) {
      CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
      CMTime delta = CMTimeSubtract(now, _pauseStartHost);
      if (CMTimeCompare(delta, kCMTimeZero) > 0) {
        totalPaused = CMTimeAdd(totalPaused, delta);
      }
    }
    if (CMTimeCompare(totalPaused, kCMTimeZero) > 0) {
      metadata[@"pausedMs"] = @(TimeToMilliseconds(totalPaused));
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
        AVVideoExpectedSourceFrameRateKey : @60,
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

// Returns a new CMSampleBuffer with PTS/DTS shifted backwards by `shift`.
// Caller owns the returned ref. Returns NULL if shift is zero (use the
// original) or if rewriting failed.
static CMSampleBufferRef MediaFileWriterShifted(CMSampleBufferRef original,
                                                 CMTime shift) {
  if (CMTimeCompare(shift, kCMTimeZero) == 0) return NULL;
  CMItemCount entries = 0;
  if (CMSampleBufferGetSampleTimingInfoArray(original, 0, NULL, &entries) != noErr ||
      entries == 0) {
    return NULL;
  }
  CMSampleTimingInfo stackTiming[16];
  CMSampleTimingInfo *timing = stackTiming;
  std::vector<CMSampleTimingInfo> heap;
  if (entries > 16) {
    heap.resize(entries);
    timing = heap.data();
  }
  if (CMSampleBufferGetSampleTimingInfoArray(original, entries, timing, &entries) != noErr) {
    return NULL;
  }
  for (CMItemCount i = 0; i < entries; ++i) {
    if (CMTIME_IS_VALID(timing[i].presentationTimeStamp)) {
      timing[i].presentationTimeStamp =
          CMTimeSubtract(timing[i].presentationTimeStamp, shift);
    }
    if (CMTIME_IS_VALID(timing[i].decodeTimeStamp)) {
      timing[i].decodeTimeStamp = CMTimeSubtract(timing[i].decodeTimeStamp, shift);
    }
  }
  CMSampleBufferRef shifted = NULL;
  OSStatus status = CMSampleBufferCreateCopyWithNewTiming(
      kCFAllocatorDefault, original, entries, timing, &shifted);
  if (status != noErr) {
    if (shifted) CFRelease(shifted);
    return NULL;
  }
  return shifted;
}

- (void)appendRetainedSampleBuffer:(CMSampleBufferRef)sampleBuffer {
  if (_finishing || _finished || _writerCreationFailed ||
      !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }
  // While paused, swallow the sample without touching the writer. The host
  // clock keeps ticking; resume time absorbs the gap.
  if (_paused.load(std::memory_order_acquire)) {
    return;
  }

  if (![self createWriterForSampleBuffer:sampleBuffer]) {
    // Latch the failure so subsequent samples don't retry the init path
    // (which would re-emit the same error every frame). One event surfaces
    // the problem to JS; the recorder should call stop/cancel from there.
    _writerCreationFailed = YES;
    EmitEvent({"error", "", ToStdString(_source), ToStdString([_error localizedDescription]), 0});
    return;
  }

  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (!CMTIME_IS_VALID(pts)) {
    pts = CMClockGetTime(CMClockGetHostTimeClock());
  }

  CMSampleBufferRef shifted =
      MediaFileWriterShifted(sampleBuffer, _pauseAccumulated);
  CMSampleBufferRef target = shifted ?: sampleBuffer;
  CMTime appendPts = shifted ? CMTimeSubtract(pts, _pauseAccumulated) : pts;

  if (!_started) {
    if (![_writer startWriting]) {
      _error = [_writer error] ?: MakeError(1003, @"Could not start media writer");
      if (shifted) CFRelease(shifted);
      return;
    }
    [_writer startSessionAtSourceTime:appendPts];
    _firstPTS = appendPts;
    _started = YES;
    EmitEvent({"fileStarted", "", ToStdString(_source), ToStdString([_url path]), 0});
  }

  if (_input.readyForMoreMediaData) {
    if (![_input appendSampleBuffer:target]) {
      _error = [_writer error] ?: MakeError(1004, @"Could not append sample buffer");
      EmitEvent({"error", "", ToStdString(_source), ToStdString([_error localizedDescription]), 0});
      if (shifted) CFRelease(shifted);
      return;
    }
    _lastPTS = appendPts;
    _sampleCount += 1;
  }
  if (shifted) CFRelease(shifted);
}

- (void)setPaused:(BOOL)paused {
  // Hop onto _queue so the state mutation is serialized with sample appends,
  // _pauseAccumulated is only ever written here, and clock-reads happen at a
  // well-defined point relative to the last appended sample.
  dispatch_async(_queue, ^{
    if (_paused.load(std::memory_order_relaxed) == (paused ? true : false)) return;
    if (paused) {
      _pauseStartHost = CMClockGetTime(CMClockGetHostTimeClock());
      _paused.store(true, std::memory_order_release);
    } else {
      if (CMTIME_IS_VALID(_pauseStartHost)) {
        CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
        CMTime delta = CMTimeSubtract(now, _pauseStartHost);
        if (CMTimeCompare(delta, kCMTimeZero) > 0) {
          _pauseAccumulated = CMTimeAdd(_pauseAccumulated, delta);
        }
      }
      _pauseStartHost = kCMTimeInvalid;
      _paused.store(false, std::memory_order_release);
      _pauseCycleCount += 1;
    }
  });
}

- (BOOL)isPaused {
  return _paused.load(std::memory_order_acquire);
}

- (CMTime)pauseAccumulated {
  __block CMTime value = kCMTimeZero;
  dispatch_sync(_queue, ^{
    value = _pauseAccumulated;
    if (_paused.load(std::memory_order_acquire) && CMTIME_IS_VALID(_pauseStartHost)) {
      CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
      CMTime delta = CMTimeSubtract(now, _pauseStartHost);
      if (CMTimeCompare(delta, kCMTimeZero) > 0) {
        value = CMTimeAdd(value, delta);
      }
    }
  });
  return value;
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
  // Drop ahead of the CFRetain/enqueue while paused so a long pause doesn't
  // pin IOSurfaces (video) on the inflight queue.
  if (_paused.load(std::memory_order_acquire)) {
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
        _writer = nil;
        _input = nil;
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
        // Drop writer + input refs so the AVAssetWriter and its file
        // handle are released as soon as finish completes, instead of
        // lingering until the whole RecorderSession deallocs (which can
        // be much later if the JS state machine holds the session).
        _writer = nil;
        _input = nil;
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
