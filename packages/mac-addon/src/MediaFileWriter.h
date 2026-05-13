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
@end
