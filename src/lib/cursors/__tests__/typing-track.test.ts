import { describe, expect, it } from "vitest"

import type { CursorTrackData } from "@/types/api"
import {
  buildCursorTrack,
  placeCursor,
  sampleFollowArtboardFocus,
  type CursorVideoGeometry,
} from "@/components/editor/canvas/cursor-scene"

import {
  TYPING_CARET_LEAD_MS,
  TYPING_FADE_IN_MS,
  TYPING_FADE_OUT_MS,
  buildTypingTrack,
  sampleTypingCaretAt,
  typingBursts,
  typingCursorAlphaAt,
  typingSessionAt,
} from "../typing-track"

const ORIGIN = 10_000

// Pointer parked at (50, 50) for the whole recording unless `moves` overrides.
function data(partial: Partial<CursorTrackData> = {}): CursorTrackData {
  return {
    moves: [
      { processTimeMs: ORIGIN, x: 50, y: 50 },
      { processTimeMs: ORIGIN + 10_000, x: 50, y: 50 },
    ],
    clicks: [],
    processTimeStartMs: ORIGIN,
    displayWidth: 200,
    displayHeight: 100,
    ...partial,
  }
}

const keys = (...ms: number[]) => ms.map((t) => ({ processTimeMs: ORIGIN + t }))

const geometry: CursorVideoGeometry = {
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  rotation: 0,
  intrinsicWidth: 200,
  intrinsicHeight: 100,
}

describe("buildTypingTrack", () => {
  it("returns null without typing keystrokes", () => {
    expect(buildTypingTrack(data())).toBeNull()
    expect(buildTypingTrack(data({ typing: [] }))).toBeNull()
  })

  it("keeps the cursor hidden until the mouse travels past the wake distance", () => {
    const track = buildTypingTrack(
      data({
        typing: keys(1000, 1200, 1400),
        moves: [
          { processTimeMs: ORIGIN, x: 50, y: 50 },
          // Jitter / shape-only synthetic move: same spot, must not wake.
          { processTimeMs: ORIGIN + 1500, x: 52, y: 51 },
          // Real move: wakes the cursor.
          { processTimeMs: ORIGIN + 3000, x: 90, y: 50 },
        ],
      })
    )!
    expect(track.sessions).toEqual([
      { startMs: 1000, endMs: 3000, lastKeyMs: 1400 },
    ])
    expect(typingSessionAt(track, 2000)).not.toBeNull()
    expect(typingSessionAt(track, 3000)).toBeNull()
  })

  it("a click ends the session and the next key starts a new one", () => {
    const track = buildTypingTrack(
      data({
        typing: keys(1000, 1100, 4000),
        clicks: [
          { processTimeMs: ORIGIN + 2000, x: 50, y: 50, type: "mouseDown" },
        ],
      })
    )!
    expect(track.sessions.map((s) => [s.startMs, s.endMs])).toEqual([
      [1000, 2000],
      [4000, Infinity],
    ])
  })
})

describe("typingCursorAlphaAt", () => {
  const track = buildTypingTrack(
    data({
      typing: keys(1000),
      clicks: [
        { processTimeMs: ORIGIN + 2000, x: 50, y: 50, type: "mouseDown" },
      ],
    })
  )!

  it("fades out at the session start and back in after it ends", () => {
    expect(typingCursorAlphaAt(track, 999)).toBe(1)
    expect(
      typingCursorAlphaAt(track, 1000 + TYPING_FADE_OUT_MS / 2)
    ).toBeCloseTo(0.5)
    expect(typingCursorAlphaAt(track, 1500)).toBe(0)
    expect(
      typingCursorAlphaAt(track, 2000 + TYPING_FADE_IN_MS / 2)
    ).toBeCloseTo(0.5)
    expect(typingCursorAlphaAt(track, 2000 + TYPING_FADE_IN_MS)).toBe(1)
  })

  it("drives placeCursor alpha only when hide-while-typing is on", () => {
    const cursor = buildCursorTrack(
      data({
        typing: keys(1000),
        clicks: [
          { processTimeMs: ORIGIN + 2000, x: 50, y: 50, type: "mouseDown" },
        ],
      })
    )!
    expect(
      placeCursor(cursor, geometry, 1.5, { hideWhileTyping: true })?.alpha
    ).toBe(0)
    expect(placeCursor(cursor, geometry, 1.5)?.alpha).toBe(1)
    expect(
      placeCursor(cursor, geometry, 3, { hideWhileTyping: true })?.alpha
    ).toBe(1)
  })
})

describe("sampleTypingCaretAt", () => {
  const track = buildTypingTrack(
    data({
      typing: keys(1000, 1200),
      caret: [
        {
          processTimeMs: ORIGIN + 1040,
          x: 100,
          y: 20,
          width: 2,
          height: 16,
          source: "caret",
        },
        {
          processTimeMs: ORIGIN + 1240,
          x: 108,
          y: 20,
          width: 2,
          height: 16,
          source: "caret",
        },
        // A whole text area's frame: too coarse to follow, dropped.
        {
          processTimeMs: ORIGIN + 1300,
          x: 0,
          y: 0,
          width: 900,
          height: 500,
          source: "element",
        },
      ],
      clicks: [
        { processTimeMs: ORIGIN + 3000, x: 50, y: 50, type: "mouseDown" },
      ],
    })
  )!

  it("holds the latest caret read inside a session (caret centre)", () => {
    expect(sampleTypingCaretAt(track, 1100)).toEqual({ x: 101, y: 28 })
    expect(sampleTypingCaretAt(track, 2500)).toEqual({ x: 109, y: 28 })
  })

  it("looks ahead to the first read so the follow has no reaction lag", () => {
    expect(sampleTypingCaretAt(track, 1000)).toEqual({ x: 101, y: 28 })
    expect(sampleTypingCaretAt(track, 1000 - TYPING_CARET_LEAD_MS + 1)).toEqual(
      {
        x: 101,
        y: 28,
      }
    )
    expect(
      sampleTypingCaretAt(track, 1000 - TYPING_CARET_LEAD_MS - 1)
    ).toBeNull()
  })

  it("returns null once pointer activity ends the session", () => {
    expect(sampleTypingCaretAt(track, 3000)).toBeNull()
  })

  it("feeds the zoom follow only when caret follow is enabled", () => {
    const cursor = buildCursorTrack(
      data({
        typing: keys(1000, 1200),
        caret: [
          {
            processTimeMs: ORIGIN + 1040,
            x: 100,
            y: 20,
            width: 2,
            height: 16,
            source: "caret",
          },
        ],
      })
    )!
    const artboard = { width: 200, height: 100 }
    const caret = sampleFollowArtboardFocus(
      cursor,
      geometry,
      1.5,
      artboard,
      true
    )
    expect(caret?.x).toBeCloseTo(101 / 200)
    expect(caret?.y).toBeCloseTo(28 / 100)
    const pointer = sampleFollowArtboardFocus(
      cursor,
      geometry,
      1.5,
      artboard,
      false
    )
    expect(pointer?.x).toBeCloseTo(50 / 200)
    expect(pointer?.y).toBeCloseTo(50 / 100)
  })
})

describe("typingBursts", () => {
  it("splits on long gaps and drops runs that are too short", () => {
    const track = buildTypingTrack(
      data({ typing: keys(1000, 1200, 1400, 5000, 9000, 9100, 9200, 9300) })
    )!
    expect(typingBursts(track, { maxGapMs: 1500, minKeys: 3 })).toEqual([
      { startMs: 1000, endMs: 1400, keyCount: 3 },
      { startMs: 9000, endMs: 9300, keyCount: 4 },
    ])
  })
})
