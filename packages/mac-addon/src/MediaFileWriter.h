#pragma once

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>

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

// Pause / resume. While paused, all samples are dropped; on resume the
// accumulated pause duration is subtracted from every subsequent sample PTS
// so the file timeline has no gap.
- (void)setPaused:(BOOL)paused;
- (BOOL)isPaused;
- (CMTime)pauseAccumulated;
@end
