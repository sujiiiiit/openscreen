{
  "targets": [
    {
      "target_name": "mac_addon",
      "sources": [
        "src/addon.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS==\"mac\"", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_CXX_LIBRARY": "libc++",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-stdlib=libc++",
              "-fobjc-arc"
            ],
            "OTHER_LDFLAGS": [
              "-framework ScreenCaptureKit",
              "-framework AVFoundation",
              "-framework CoreMedia",
              "-framework CoreVideo",
              "-framework CoreGraphics",
              "-framework IOSurface",
              "-framework AudioToolbox",
              "-framework AppKit",
              "-framework Foundation",
              "-framework Accelerate"
            ]
          }
        }]
      ]
    }
  ]
}
