#pragma once

#import <Foundation/Foundation.h>

// Builds a catalog of every known NSCursor shape (public + private factory
// selectors) and persists it as a Screen Studio-style `cursors.json` plus one
// `cursors/<id>.png` per shape. At runtime it resolves the semantic id of the
// currently displayed system cursor (`arrow`, `iBeam`, `windowResizeEastWest`,
// …) by matching the live cursor's bitmap against the catalog. Cursors it has
// never seen (an app's custom cursor) are added on the fly with
// `systemCursor:false`.
//
// THREADING: NSCursor is AppKit and main-thread affine. Every method here must
// be invoked on the main thread.
@interface CursorCatalog : NSObject

// Enumerate all known cursors, hash their bitmaps, and write `cursors/<id>.png`
// into `imagesDirectory`. Returns the number of system cursors catalogued.
- (NSUInteger)buildIntoImagesDirectory:(NSURL *)imagesDirectory;

// The cursors.json payload — an array of
// `{id, hotSpot{x,y}, standardSize{width,height}, systemCursor}` dictionaries.
// Includes any custom cursors discovered during -resolveCurrentCursorId.
- (NSArray *)catalogEntries;

// Resolve the id of `[NSCursor currentSystemCursor]`. Falls back to the app's
// current cursor, then to "arrow", and registers unknown cursors as
// "custom-N". Main thread only.
- (NSString *)resolveCurrentCursorId;

@end
