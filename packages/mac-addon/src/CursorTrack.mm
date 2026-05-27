#include "CursorTrack.h"

#import <AppKit/AppKit.h>

#include <cstdint>

// Selector → Screen Studio id map for every NSCursor factory we know about.
// The public factories (arrow, iBeam, the resize* family, …) are guaranteed on
// every supported macOS; the leading-underscore entries are private factories
// that produce the window-resize and corner-resize shapes. Each is probed with
// +respondsToSelector: before use, so a macOS release that drops or renames one
// simply omits it from the catalog rather than crashing. Distributed outside
// the Mac App Store, so the private selectors are acceptable.
typedef struct {
  const char *selector;
  const char *cursorId;
} CursorFactory;

static const CursorFactory kCursorFactories[] = {
    // Public factories.
    {"arrowCursor", "arrow"},
    {"IBeamCursor", "iBeam"},
    {"IBeamCursorForVerticalLayout", "iBeamCursorForVerticalLayout"},
    {"crosshairCursor", "crosshair"},
    {"closedHandCursor", "closedHand"},
    {"openHandCursor", "openHand"},
    {"pointingHandCursor", "pointingHand"},
    {"resizeLeftCursor", "resizeLeft"},
    {"resizeRightCursor", "resizeRight"},
    {"resizeLeftRightCursor", "resizeLeftRight"},
    {"resizeUpCursor", "resizeUp"},
    {"resizeDownCursor", "resizeDown"},
    {"resizeUpDownCursor", "resizeUpDown"},
    {"disappearingItemCursor", "disappearingItem"},
    {"operationNotAllowedCursor", "operationNotAllowed"},
    {"dragLinkCursor", "dragLink"},
    {"dragCopyCursor", "dragCopy"},
    {"contextualMenuCursor", "contextualMenu"},
    // Private factories.
    {"_helpCursor", "help"},
    {"_zoomInCursor", "zoomIn"},
    {"_zoomOutCursor", "zoomOut"},
    {"busyButClickableCursor", "busyButClickable"},
    {"_bottomLeftResizeCursor", "bottomLeftResize"},
    {"_bottomRightResizeCursor", "bottomRightResize"},
    {"_topLeftResizeCursor", "topLeftResize"},
    {"_topRightResizeCursor", "topRightResize"},
    {"_windowResizeNorthCursor", "windowResizeNorth"},
    {"_windowResizeSouthCursor", "windowResizeSouth"},
    {"_windowResizeEastCursor", "windowResizeEast"},
    {"_windowResizeWestCursor", "windowResizeWest"},
    {"_windowResizeNorthEastCursor", "windowResizeNorthEast"},
    {"_windowResizeNorthWestCursor", "windowResizeNorthWest"},
    {"_windowResizeSouthEastCursor", "windowResizeSouthEast"},
    {"_windowResizeSouthWestCursor", "windowResizeSouthWest"},
    {"_windowResizeNorthSouthCursor", "windowResizeNorthSouth"},
    {"_windowResizeEastWestCursor", "windowResizeEastWest"},
    {"_windowResizeNorthEastSouthWestCursor", "windowResizeNorthEastSouthWest"},
    {"_windowResizeNorthWestSouthEastCursor", "windowResizeNorthWestSouthEast"},
};

// FNV-1a over the image's TIFF representation. Identical bitmaps (same pixels +
// reps) hash identically, so a system cursor's live image matches its catalog
// entry. TIFF is byte-stable for identical content, unlike PNG (which can carry
// timestamps).
static uint64_t HashCursorImage(NSImage *image) {
  if (!image) return 0;
  NSData *tiff = [image TIFFRepresentation];
  if (!tiff) return 0;
  const unsigned char *bytes = (const unsigned char *)tiff.bytes;
  NSUInteger length = tiff.length;
  uint64_t hash = 1469598103934665603ULL;
  for (NSUInteger i = 0; i < length; ++i) {
    hash ^= bytes[i];
    hash *= 1099511628211ULL;
  }
  return hash;
}

// Resolve a class-method factory without tripping ARC's "performSelector may
// cause a leak" warning. Returns nil if NSCursor doesn't respond to `sel`.
static NSCursor *CursorFromFactory(SEL sel) {
  if (![NSCursor respondsToSelector:sel]) return nil;
  IMP imp = [NSCursor methodForSelector:sel];
  if (!imp) return nil;
  NSCursor *(*typed)(id, SEL) = (NSCursor * (*)(id, SEL))imp;
  return typed([NSCursor class], sel);
}

@implementation CursorCatalog {
  NSMutableArray<NSDictionary *> *_entries;
  NSMutableDictionary<NSNumber *, NSString *> *_hashToId;
  NSURL *_imagesDirectory;
  NSUInteger _customCount;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _entries = [NSMutableArray array];
    _hashToId = [NSMutableDictionary dictionary];
    _customCount = 0;
  }
  return self;
}

- (void)writePNGForImage:(NSImage *)image id:(NSString *)cursorId {
  if (!_imagesDirectory || !image) return;
  // Persist the highest-resolution representation (Screen Studio stores cursor
  // PNGs at native asset resolution, e.g. arrow at 280×400, not the 28×40
  // point size).
  NSBitmapImageRep *best = nil;
  for (NSImageRep *rep in image.representations) {
    if (![rep isKindOfClass:[NSBitmapImageRep class]]) continue;
    NSBitmapImageRep *candidate = (NSBitmapImageRep *)rep;
    if (!best || candidate.pixelsWide * candidate.pixelsHigh >
                     best.pixelsWide * best.pixelsHigh) {
      best = candidate;
    }
  }
  if (!best) best = [NSBitmapImageRep imageRepWithData:[image TIFFRepresentation]];
  NSData *png = [best representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png) return;
  NSURL *url = [_imagesDirectory
      URLByAppendingPathComponent:[cursorId stringByAppendingPathExtension:@"png"]];
  [png writeToURL:url atomically:YES];
}

- (NSDictionary *)entryForCursor:(NSCursor *)cursor
                              id:(NSString *)cursorId
                          system:(BOOL)system {
  NSPoint hotSpot = cursor.hotSpot;
  NSSize size = cursor.image.size;
  return @{
    @"id" : cursorId,
    @"hotSpot" : @{@"x" : @(hotSpot.x), @"y" : @(hotSpot.y)},
    @"standardSize" : @{@"width" : @(size.width), @"height" : @(size.height)},
    @"systemCursor" : @(system),
  };
}

- (NSUInteger)buildIntoImagesDirectory:(NSURL *)imagesDirectory {
  _imagesDirectory = imagesDirectory;
  [[NSFileManager defaultManager] createDirectoryAtURL:imagesDirectory
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];

  NSUInteger count = sizeof(kCursorFactories) / sizeof(kCursorFactories[0]);
  for (NSUInteger i = 0; i < count; ++i) {
    SEL sel = NSSelectorFromString(@(kCursorFactories[i].selector));
    NSCursor *cursor = CursorFromFactory(sel);
    if (!cursor || !cursor.image) continue;

    NSString *cursorId = @(kCursorFactories[i].cursorId);
    uint64_t hash = HashCursorImage(cursor.image);
    // First id wins when two factories share a bitmap (e.g. the resize family
    // collapsing to one image) — runtime resolution then maps the shared
    // bitmap to that id, while every id still appears in cursors.json.
    NSNumber *key = @(hash);
    if (!_hashToId[key]) _hashToId[key] = cursorId;

    [_entries addObject:[self entryForCursor:cursor id:cursorId system:YES]];
    [self writePNGForImage:cursor.image id:cursorId];
  }
  return _entries.count;
}

- (NSArray *)catalogEntries {
  return [_entries copy];
}

- (NSString *)resolveCurrentCursorId {
  NSCursor *cursor = [NSCursor currentSystemCursor];
  if (!cursor) cursor = [NSCursor currentCursor];
  if (!cursor || !cursor.image) return @"arrow";

  uint64_t hash = HashCursorImage(cursor.image);
  NSNumber *key = @(hash);
  NSString *known = _hashToId[key];
  if (known) return known;

  // Unknown bitmap → an app's custom cursor. Register it so subsequent
  // resolutions are O(1) and it appears in cursors.json with systemCursor:false.
  NSString *cursorId = [NSString stringWithFormat:@"custom-%lu", (unsigned long)_customCount++];
  _hashToId[key] = cursorId;
  [_entries addObject:[self entryForCursor:cursor id:cursorId system:NO]];
  [self writePNGForImage:cursor.image id:cursorId];
  return cursorId;
}

@end
