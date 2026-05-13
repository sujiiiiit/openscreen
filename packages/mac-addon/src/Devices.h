#pragma once

#include <napi.h>

#import <AVFoundation/AVFoundation.h>

#include <string>

// Lookup an AVCaptureDevice by uniqueID, falling back to the default device
// for the media type when uniqueID is empty or no match is found.
AVCaptureDevice *CaptureDeviceForUniqueID(const std::string &uniqueID,
                                          AVMediaType mediaType);

// JS-facing enumeration helpers.
Napi::Value ListDevicesValue(const Napi::CallbackInfo &info, AVMediaType mediaType);
