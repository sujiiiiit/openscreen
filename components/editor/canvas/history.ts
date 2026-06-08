// Pure history primitives for the editor's undo / redo stack.
//
// This module is intentionally free of React, DOM, and `Date.now()` so it can
// be unit-tested without booting the editor. The provider owns the mutable
// ref and clock; this file owns the decision rules.
//
// Capture is autosave-debounce-aligned: every time the autosave drain writes
// (or skips a fingerprint no-op), the provider calls `applyHistoryCommit`
// with the just-serialized snapshot and the most-recent action's tag.
// Coalescing collapses same-tag edits within `HISTORY_COALESCE_WINDOW_MS`
// into a single entry by replacing the top instead of pushing a new one.
//
// See `docs/editor-canvas.md` → "Undo / Redo" for the user-visible contract.
import type { ProjectStateV1 } from "@/types/api"

export type HistoryCommitTag =
  | "appearance"
  | "add"
  | "delete"
  | "preset"
  | "background"
  | "background-enabled"
  | "padding"
  | "grain"
  | "cursor-custom-rendering"
  | "cursor-set"
  | "cursor-size"
  | "cursor-smoothing"
  | "cursor-click-press-scale"
  | "cursor-always-use-pointer"
  | "cursor-motion-rotation"
  | "cursor-motion-blur"
  | "cursor-motion-blur-backend"
  | "clip-move"
  | "clip-resize"
  | "zoom-add"
  | "zoom-move"
  | "zoom-resize"
  | "zoom-settings"
  | "zoom-remove"
  | "zoom-auto-generate"
  | "unknown"

export interface HistoryEntry {
  state: ProjectStateV1
  fingerprint: string | null
  tag: HistoryCommitTag
  timestamp: number
}

export interface EditorHistory {
  past: HistoryEntry[]
  cursor: number
}

export const MAX_HISTORY_ENTRIES = 100

// Must exceed the 500ms autosave debounce by at least a few cycles so a
// slider parked mid-drag for one debounce window still coalesces with the
// next push. Two seconds is wide enough to feel like "the same action" yet
// tight enough that distinct user intents do not silently merge.
export const HISTORY_COALESCE_WINDOW_MS = 2000

// Destructive or structural actions always create their own undo entry so
// a single Cmd+Z undoes exactly one of them. These also call
// `flushAutosaveNow()` in the provider before mutating to promote any
// pending non-destructive edits into a separate preceding entry.
export const ALWAYS_NEW_ENTRY_TAGS: ReadonlySet<HistoryCommitTag> = new Set([
  "add",
  "delete",
  "preset",
  // One-shot auto-zoom generation (first open of a recording) is a single
  // atomic undo step, so Cmd+Z removes all generated zooms in one go.
  "zoom-auto-generate",
])

export function createEmptyHistory(): EditorHistory {
  return { past: [], cursor: -1 }
}

export function canUndoHistory(history: EditorHistory): boolean {
  return history.cursor > 0
}

export function canRedoHistory(history: EditorHistory): boolean {
  return history.cursor >= 0 && history.cursor < history.past.length - 1
}

export function getUndoTargetEntry(
  history: EditorHistory
): HistoryEntry | null {
  if (!canUndoHistory(history)) return null
  return history.past[history.cursor - 1] ?? null
}

export function getRedoTargetEntry(
  history: EditorHistory
): HistoryEntry | null {
  if (!canRedoHistory(history)) return null
  return history.past[history.cursor + 1] ?? null
}

export interface ApplyHistoryCommitResult {
  next: EditorHistory
  didPush: boolean
  didReplace: boolean
}

export function applyHistoryCommit(
  history: EditorHistory,
  state: ProjectStateV1,
  fingerprint: string | null,
  tag: HistoryCommitTag,
  now: number
): ApplyHistoryCommitResult {
  const newEntry: HistoryEntry = { state, fingerprint, tag, timestamp: now }

  // First snapshot: just seed.
  if (history.past.length === 0 || history.cursor < 0) {
    return {
      next: { past: [newEntry], cursor: 0 },
      didPush: true,
      didReplace: false,
    }
  }

  const top = history.past[history.cursor]

  // Identical snapshot — refresh the timestamp so a follow-up same-tag edit
  // still coalesces within the window, but do not allocate a new entry.
  // Preserve the existing tag when the incoming tag is "unknown" so a benign
  // no-op flush (e.g. the post-`flushAutosaveNow` drain) cannot demote a
  // meaningful tag like "appearance" to "unknown" and break the next
  // coalesce check.
  if (
    top &&
    fingerprint !== null &&
    top.fingerprint !== null &&
    fingerprint === top.fingerprint
  ) {
    const past = history.past.slice()
    past[history.cursor] = {
      ...top,
      tag: tag === "unknown" ? top.tag : tag,
      timestamp: now,
    }
    return {
      next: { past, cursor: history.cursor },
      didPush: false,
      didReplace: false,
    }
  }

  const shouldPushNew =
    ALWAYS_NEW_ENTRY_TAGS.has(tag) ||
    tag === "unknown" ||
    !top ||
    top.tag !== tag ||
    now - top.timestamp > HISTORY_COALESCE_WINDOW_MS

  if (shouldPushNew) {
    // Truncate any redo tail before appending, then FIFO-trim at the cap.
    const truncated = history.past.slice(0, history.cursor + 1)
    truncated.push(newEntry)
    const trimmed =
      truncated.length > MAX_HISTORY_ENTRIES
        ? truncated.slice(truncated.length - MAX_HISTORY_ENTRIES)
        : truncated
    return {
      next: { past: trimmed, cursor: trimmed.length - 1 },
      didPush: true,
      didReplace: false,
    }
  }

  // Same tag, within window, different fingerprint — replace the top so
  // a continuous drag becomes one undo step. Drop any redo tail past the
  // cursor: if the user undid into the middle of the stack and is now
  // editing on top of that entry, the surviving redo entries describe a
  // future that no longer matches the new branch and would replay onto
  // unrelated state.
  const past = history.past.slice(0, history.cursor + 1)
  past[history.cursor] = newEntry
  return {
    next: { past, cursor: history.cursor },
    didPush: false,
    didReplace: true,
  }
}
