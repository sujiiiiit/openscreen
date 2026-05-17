#include "Devices.h"

#include "Common.h"

AVCaptureDevice *CaptureDeviceForUniqueID(const std::string &uniqueID,
                                          AVMediaType mediaType) {
  if (!uniqueID.empty()) {
    AVCaptureDevice *device =
        [AVCaptureDevice deviceWithUniqueID:ToNSString(uniqueID)];
    if (device) {
      return device;
    }
  }
  return [AVCaptureDevice defaultDeviceWithMediaType:mediaType];
}

Napi::Value ListDevicesValue(const Napi::CallbackInfo &info, AVMediaType mediaType) {
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
