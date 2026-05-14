"use client"

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { RecordIcon } from "@/components/ui/record-icon"
import { Spinner } from "@/components/ui/spinner"
import type {
  PickerOverlayTarget,
  RegionSelectionBounds,
  WindowPickerSession,
} from "@/types/api"

type DraftRegion = {
  startX: number
  startY: number
  currentX: number
  currentY: number
  pointerId: number
  hasDragged: boolean
  clearedSelection: boolean
}

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw"

type RegionEdit = {
  kind: "move" | "resize"
  handle?: ResizeHandle
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  initialBounds: RegionSelectionBounds
}

const EMPTY_SESSION: WindowPickerSession = {
  mode: null,
  minRegionWidth: 160,
  minRegionHeight: 90,
  locked: false,
}
const REGION_DRAG_THRESHOLD = 4

const RESIZE_HANDLES: Array<{
  id: ResizeHandle
  label: string
  className: string
  indicatorClassName: string
}> = [
  {
    id: "nw",
    label: "Resize top left",
    className: "top-0 left-0 size-7 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "n",
    label: "Resize top edge",
    className: "top-0 left-1/2 size-7 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "ne",
    label: "Resize top right",
    className: "top-0 right-0 size-7 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "e",
    label: "Resize right edge",
    className: "top-1/2 right-0 size-7 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "se",
    label: "Resize bottom right",
    className: "right-0 bottom-0 size-7 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "s",
    label: "Resize bottom edge",
    className: "bottom-0 left-1/2 size-7 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "sw",
    label: "Resize bottom left",
    className: "bottom-0 left-0 size-7 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
  {
    id: "w",
    label: "Resize left edge",
    className: "top-1/2 left-0 size-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
    indicatorClassName: "size-2.5 rounded-full",
  },
]

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function pointerPoint(event: PointerEvent<HTMLElement>) {
  return {
    x: clamp(event.clientX, 0, window.innerWidth),
    y: clamp(event.clientY, 0, window.innerHeight),
  }
}

function normalizeDraft(draft: DraftRegion): RegionSelectionBounds {
  const x = Math.min(draft.startX, draft.currentX)
  const y = Math.min(draft.startY, draft.currentY)
  return {
    x,
    y,
    width: Math.abs(draft.currentX - draft.startX),
    height: Math.abs(draft.currentY - draft.startY),
  }
}

function draftDistance(draft: DraftRegion) {
  return Math.hypot(draft.currentX - draft.startX, draft.currentY - draft.startY)
}

function evenDimension(value: number) {
  const rounded = Math.round(value)
  const even = rounded % 2 === 0 ? rounded : rounded - 1
  return Math.max(2, even)
}

function regionSizeLabel(bounds: RegionSelectionBounds, scaleFactor = 1) {
  return `${evenDimension(bounds.width * scaleFactor)} × ${evenDimension(
    bounds.height * scaleFactor
  )}`
}

function scaleFactorForTarget(target: PickerOverlayTarget | null) {
  const scaleFactor = target?.target.scaleFactor
  return typeof scaleFactor === "number" && scaleFactor > 0 ? scaleFactor : 1
}

function moveRegionBounds(edit: RegionEdit): RegionSelectionBounds {
  const dx = edit.currentX - edit.startX
  const dy = edit.currentY - edit.startY
  const width = Math.min(edit.initialBounds.width, window.innerWidth)
  const height = Math.min(edit.initialBounds.height, window.innerHeight)
  return {
    x: clamp(edit.initialBounds.x + dx, 0, Math.max(0, window.innerWidth - width)),
    y: clamp(
      edit.initialBounds.y + dy,
      0,
      Math.max(0, window.innerHeight - height)
    ),
    width,
    height,
  }
}

function resizeRegionBounds(
  edit: RegionEdit,
  minWidth: number,
  minHeight: number
): RegionSelectionBounds {
  const handle = edit.handle
  if (!handle) return edit.initialBounds

  const dx = edit.currentX - edit.startX
  const dy = edit.currentY - edit.startY
  let left = edit.initialBounds.x
  let top = edit.initialBounds.y
  let right = edit.initialBounds.x + edit.initialBounds.width
  let bottom = edit.initialBounds.y + edit.initialBounds.height
  const movesWest = handle.includes("w")
  const movesEast = handle.includes("e")
  const movesNorth = handle.includes("n")
  const movesSouth = handle.includes("s")

  if (movesWest) left += dx
  if (movesEast) right += dx
  if (movesNorth) top += dy
  if (movesSouth) bottom += dy

  left = clamp(left, 0, window.innerWidth)
  right = clamp(right, 0, window.innerWidth)
  top = clamp(top, 0, window.innerHeight)
  bottom = clamp(bottom, 0, window.innerHeight)

  if (right - left < minWidth) {
    if (movesWest && !movesEast) {
      left = right - minWidth
    } else {
      right = left + minWidth
    }
  }
  if (bottom - top < minHeight) {
    if (movesNorth && !movesSouth) {
      top = bottom - minHeight
    } else {
      bottom = top + minHeight
    }
  }

  if (left < 0) {
    right = Math.min(window.innerWidth, right - left)
    left = 0
  }
  if (right > window.innerWidth) {
    left = Math.max(0, left - (right - window.innerWidth))
    right = window.innerWidth
  }
  if (top < 0) {
    bottom = Math.min(window.innerHeight, bottom - top)
    top = 0
  }
  if (bottom > window.innerHeight) {
    top = Math.max(0, top - (bottom - window.innerHeight))
    bottom = window.innerHeight
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(minWidth, right - left)),
    height: Math.round(Math.max(minHeight, bottom - top)),
  }
}

function regionBoundsFromEdit(
  edit: RegionEdit,
  minWidth: number,
  minHeight: number
): RegionSelectionBounds {
  return edit.kind === "move"
    ? moveRegionBounds(edit)
    : resizeRegionBounds(edit, minWidth, minHeight)
}

function regionControlStyle(target: PickerOverlayTarget): CSSProperties {
  const padding = 14
  const gap = 12
  const estimatedWidth = Math.min(280, Math.max(180, window.innerWidth - padding * 2))
  const estimatedHeight = 48
  const centerX = target.bounds.x + target.bounds.width / 2
  const maxLeft = Math.max(padding, window.innerWidth - estimatedWidth - padding)
  const left = clamp(
    centerX - estimatedWidth / 2,
    padding,
    maxLeft
  )
  let top = target.bounds.y + target.bounds.height + gap

  if (top + estimatedHeight > window.innerHeight - padding) {
    top = target.bounds.y - estimatedHeight - gap
  }
  if (top < padding) {
    const insideBottom = target.bounds.y + target.bounds.height - estimatedHeight - padding
    top = clamp(
      insideBottom,
      padding,
      Math.max(padding, window.innerHeight - estimatedHeight - padding)
    )
  }

  return {
    width: estimatedWidth,
    transform: `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`,
  }
}

function RegionScrim({
  bounds,
}: {
  bounds: RegionSelectionBounds | null
}) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
    >
      <defs>
        <mask id="region-picker-cutout">
          <rect width="100%" height="100%" fill="white" />
          {bounds && (
            <rect
              x={bounds.x}
              y={bounds.y}
              width={bounds.width}
              height={bounds.height}
              rx={12}
              fill="black"
            />
          )}
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        fill="rgba(0, 0, 0, 0.56)"
        mask="url(#region-picker-cutout)"
      />
    </svg>
  )
}

function RegionResizeHandles({
  onResizeStart,
}: {
  onResizeStart: (
    handle: ResizeHandle,
    event: PointerEvent<HTMLButtonElement>
  ) => void
}) {
  return (
    <>
      {RESIZE_HANDLES.map((handle) => (
        <button
          key={handle.id}
          type="button"
          aria-label={handle.label}
          className={`pointer-events-auto absolute z-20 flex items-center justify-center rounded-full outline-none ${handle.className}`}
          onPointerDown={(event) => onResizeStart(handle.id, event)}
        >
          <span
            className={`block border border-background/75 bg-white shadow-[0_1px_8px_rgba(0,0,0,0.45)] ring-1 ring-foreground/25 ${handle.indicatorClassName}`}
          />
        </button>
      ))}
    </>
  )
}

export default function WindowPickerPage() {
  const [session, setSession] = useState<WindowPickerSession>(EMPTY_SESSION)
  const [target, setTarget] = useState<PickerOverlayTarget | null>(null)
  const [draft, setDraft] = useState<DraftRegion | null>(null)
  const [edit, setEdit] = useState<RegionEdit | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const isRegionMode =
    session.mode === "region" || target?.mode === "region" || session.locked
  const draftBounds = useMemo(() => (draft ? normalizeDraft(draft) : null), [draft])
  const editBounds = useMemo(
    () =>
      edit
        ? regionBoundsFromEdit(
            edit,
            session.minRegionWidth,
            session.minRegionHeight
          )
        : null,
    [edit, session.minRegionHeight, session.minRegionWidth]
  )

  useEffect(() => {
    if (!window.api?.windowPicker) return undefined

    const unsubscribe = window.api.windowPicker.onTargetChanged((nextTarget) => {
      setTarget(nextTarget)
      if (nextTarget) setMessage(null)
    })

    let stale = false
    Promise.all([
      window.api.windowPicker.getSession(),
      window.api.windowPicker.getCurrentTarget(),
    ]).then(([currentSession, currentTarget]) => {
      if (stale) return
      setSession(currentSession)
      if (currentTarget) setTarget(currentTarget)
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void window.api.windowPicker.cancel()
      }
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      stale = true
      unsubscribe()
      window.removeEventListener("keydown", onKeyDown)
      void window.api.windowPicker.setInteractive(false)
    }
  }, [])

  async function setInteractive(interactive: boolean) {
    await window.api?.windowPicker?.setInteractive(interactive)
  }

  async function clearRegionSelection() {
    if (!window.api?.windowPicker) return
    await window.api.windowPicker.setRegionSelection(null)
  }

  function beginRegionDrag(event: PointerEvent<HTMLElement>) {
    if (!isRegionMode || confirming) return
    if (target?.locked || session.locked) return
    if (event.button !== 0) return

    const point = pointerPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setEdit(null)
    setMessage(null)
    setDraft({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      pointerId: event.pointerId,
      hasDragged: false,
      clearedSelection: false,
    })
  }

  function updateRegionDrag(event: PointerEvent<HTMLElement>) {
    const point = pointerPoint(event)
    if (draft && event.pointerId === draft.pointerId) {
      const nextDraft = { ...draft, currentX: point.x, currentY: point.y }
      const hasDragged =
        draft.hasDragged || draftDistance(nextDraft) >= REGION_DRAG_THRESHOLD
      if (hasDragged && !draft.clearedSelection) {
        setTarget(null)
        void clearRegionSelection()
      }
      setDraft((current) =>
        current && current.pointerId === event.pointerId
          ? {
              ...current,
              currentX: point.x,
              currentY: point.y,
              hasDragged,
              clearedSelection: current.clearedSelection || hasDragged,
            }
          : current
      )
      return
    }
    if (edit && event.pointerId === edit.pointerId) {
      setEdit((current) =>
        current && current.pointerId === event.pointerId
          ? { ...current, currentX: point.x, currentY: point.y }
          : current
      )
    }
  }

  async function finishRegionDrag(event: PointerEvent<HTMLElement>) {
    const point = pointerPoint(event)

    if (edit && event.pointerId === edit.pointerId) {
      const nextEdit = { ...edit, currentX: point.x, currentY: point.y }
      const bounds = regionBoundsFromEdit(
        nextEdit,
        session.minRegionWidth,
        session.minRegionHeight
      )
      const result = await window.api?.windowPicker?.setRegionSelection(bounds)
      setTarget(result?.target ?? null)
      setMessage(result?.message ?? null)
      setEdit(null)
      return
    }

    if (!draft || event.pointerId !== draft.pointerId) return
    const nextDraft = { ...draft, currentX: point.x, currentY: point.y }
    const bounds = normalizeDraft(nextDraft)

    if (!nextDraft.hasDragged && draftDistance(nextDraft) < REGION_DRAG_THRESHOLD) {
      setDraft(null)
      return
    }

    if (
      bounds.width < session.minRegionWidth ||
      bounds.height < session.minRegionHeight
    ) {
      await clearRegionSelection()
      setDraft(null)
      setMessage(
        `Draw a region at least ${session.minRegionWidth} × ${session.minRegionHeight}.`
      )
      return
    }

    const result = await window.api?.windowPicker?.setRegionSelection(bounds)
    setTarget(result?.target ?? null)
    setMessage(result?.message ?? null)
    setDraft(null)
  }

  function beginRegionMove(event: PointerEvent<HTMLElement>) {
    if (confirming || target?.mode !== "region") return
    if (target.locked || session.locked) return
    if (event.button !== 0) return
    event.stopPropagation()

    const point = pointerPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setEdit({
      kind: "move",
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      initialBounds: target.bounds,
    })
  }

  function beginRegionResize(
    handle: ResizeHandle,
    event: PointerEvent<HTMLButtonElement>
  ) {
    if (confirming || target?.mode !== "region") return
    if (target.locked || session.locked) return
    if (event.button !== 0) return
    event.stopPropagation()

    const point = pointerPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setEdit({
      kind: "resize",
      handle,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      initialBounds: target.bounds,
    })
  }

  async function startRecording() {
    if (confirming) return
    setConfirming(true)
    try {
      await window.api?.windowPicker?.confirm()
    } finally {
      setConfirming(false)
    }
  }

  if (!target && !isRegionMode) {
    return (
      <main
        data-window="window-picker"
        className="h-screen w-screen bg-transparent"
      />
    )
  }

  const selection = target?.mode === "region" && editBounds
    ? {
        ...target,
        bounds: editBounds,
        sizeLabel: regionSizeLabel(editBounds, scaleFactorForTarget(target)),
      }
    : target ?? (draftBounds
    ? ({
        mode: "region",
        title: "Region",
        sizeLabel: regionSizeLabel(draftBounds),
        modeLabel: "Region",
        bounds: draftBounds,
        target: { type: "region", displayId: 0 },
      } as PickerOverlayTarget)
    : null)
  const isDisplay = target?.mode === "display"
  const isRegionSelection = selection?.mode === "region"
  const isLockedRegion = isRegionSelection && selection?.locked === true
  const targetWidth = Math.max(1, selection?.bounds.width ?? 1)
  const targetHeight = Math.max(1, selection?.bounds.height ?? 1)
  const cornerRadius = isDisplay
    ? 0
    : Math.min(22, Math.max(10, Math.min(targetWidth, targetHeight) / 20))

  return (
    <main
      data-window="window-picker"
      className="relative h-screen w-screen overflow-hidden bg-transparent text-foreground transition-none select-none"
      onPointerDown={beginRegionDrag}
      onPointerMove={updateRegionDrag}
      onPointerUp={finishRegionDrag}
      onPointerCancel={() => {
        setDraft(null)
        setEdit(null)
      }}
    >
      {isRegionMode && <RegionScrim bounds={selection?.bounds ?? null} />}

      {isRegionMode && !selection && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/60 bg-background/70 px-6 py-4 text-center shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-xl">
            <p className="text-sm font-medium text-foreground">
              Drag and draw region
            </p>
            <p className="text-xs text-muted-foreground">
              {message ?? "Press Esc to cancel"}
            </p>
          </div>
        </div>
      )}

      {selection && !isLockedRegion && (
        <section
          className={
            isRegionSelection && target?.mode === "region"
              ? "pointer-events-auto absolute top-0 left-0 flex cursor-move items-center justify-center overflow-visible bg-transparent"
              : "pointer-events-none absolute top-0 left-0 flex items-center justify-center overflow-hidden border border-border/60 bg-background/35 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06),0_0_0_1px_rgba(0,0,0,0.25)]"
          }
          onPointerDown={
            isRegionSelection && target?.mode === "region"
              ? beginRegionMove
              : undefined
          }
          style={{
            width: targetWidth,
            height: targetHeight,
            borderRadius: isRegionSelection ? 0 : cornerRadius,
            contain: isRegionSelection ? "layout style" : "layout paint style",
            transform: `translate3d(${selection.bounds.x}px, ${selection.bounds.y}px, 0)`,
            transition: "none",
            willChange: "transform, width, height",
          }}
        >
          <div className="absolute inset-x-0 top-0 h-px bg-foreground/15" />

          {!isRegionSelection && target && (
            <div className="relative flex min-w-70 flex-col items-center">
              {target.iconDataUrl && !isDisplay && (
                <div className="mb-5 flex size-19 items-center justify-center overflow-hidden">
                  <Image
                    src={target.iconDataUrl}
                    alt=""
                    width={72}
                    height={72}
                    sizes="72px"
                    priority
                    className="size-full object-contain"
                    draggable={false}
                  />
                </div>
              )}

              <h1 className="max-w-96 truncate text-center text-[32px] leading-none font-semibold text-foreground drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]">
                {target.title}
              </h1>

              <div className="mt-3 flex items-center gap-2 text-sm font-medium text-foreground/85 drop-shadow-[0_1px_4px_rgba(0,0,0,0.45)]">
                <span>{target.sizeLabel}</span>
              </div>

              <div
                className="pointer-events-auto mt-7 flex flex-col items-center gap-4"
                onPointerEnter={() => void setInteractive(true)}
                onPointerLeave={() => void setInteractive(false)}
                onFocus={() => void setInteractive(true)}
                onBlur={() => void setInteractive(false)}
              >
                <Button
                  size="lg"
                  onClick={startRecording}
                  disabled={confirming}
                  aria-label={`Start recording ${target.title}`}
                >
                  {confirming ? (
                    <Spinner size={16} className="text-current" />
                  ) : (
                    <RecordIcon
                      data-icon="inline-start"
                      size={20}
                      className="text-current"
                    />
                  )}
                  <span>Start recording</span>
                </Button>
              </div>
            </div>
          )}

          {isRegionSelection && (
            <>
              <div className="pointer-events-none absolute top-2 left-2 rounded-full border border-border/60 bg-background/85 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-xl">
                {selection.sizeLabel}
              </div>
              {target?.mode === "region" && !selection.locked && (
                <RegionResizeHandles onResizeStart={beginRegionResize} />
              )}
            </>
          )}
        </section>
      )}

      {target?.mode === "region" &&
        selection?.mode === "region" &&
        !selection.locked && (
        <div
          className="pointer-events-auto absolute top-0 left-0 flex items-center justify-between gap-3 rounded-full border border-border/60 bg-background/85 p-1.5 pl-4 shadow-[0_18px_60px_rgba(0,0,0,0.34)] backdrop-blur-xl"
          style={regionControlStyle(selection)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
            {selection.sizeLabel}
          </span>
          <Button
            size="lg"
            onClick={startRecording}
            disabled={confirming}
            aria-label="Start recording region"
          >
            {confirming ? (
              <Spinner size={16} className="text-current" />
            ) : (
              <RecordIcon
                data-icon="inline-start"
                size={20}
                className="text-current"
              />
            )}
            <span>Start recording</span>
          </Button>
        </div>
      )}
    </main>
  )
}
