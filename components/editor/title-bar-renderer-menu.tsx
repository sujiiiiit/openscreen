"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon, GpuIcon } from "@hugeicons/core-free-icons"

import {
  clampRendererBackendPreference,
  getRendererBackendPreference,
  RENDERER_BACKEND_DEFAULT,
  setRendererBackendPreference,
  type RendererBackendPreference,
} from "@/components/editor/canvas/pixi/renderer-preference"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NO_DRAG } from "@/lib/window-drag"

const RENDERER_LABELS: Record<RendererBackendPreference, string> = {
  webgpu: "WebGPU",
  webgl: "WebGL",
}

/**
 * Titlebar dropdown choosing the PixiJS renderer backend (WebGPU default /
 * WebGL). The persisted preference applies to the editor preview AND the
 * export (shared `localStorage`); selecting a backend dispatches the change
 * event that remounts the Pixi canvas immediately. The WebGPU environment
 * gate in `renderer-preference.ts` still wins, so forcing WebGPU in an
 * unsupported environment silently runs WebGL instead of crashing.
 */
export function TitleBarRendererMenu() {
  // SSR has no localStorage, so the first client render must match the
  // server-rendered default; the persisted value is synced in after
  // hydration (one benign label flip when the user saved a non-default).
  const [backend, setBackend] = useState<RendererBackendPreference>(
    RENDERER_BACKEND_DEFAULT
  )
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-hydration sync from localStorage
    setBackend(getRendererBackendPreference())
  }, [])
  const applyBackend = (value: RendererBackendPreference) => {
    setBackend(value)
    setRendererBackendPreference(value)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label="Renderer backend"
            style={NO_DRAG}
          />
        }
      >
        <HugeiconsIcon icon={GpuIcon} />
        <span>{RENDERER_LABELS[backend]}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" sideOffset={8} className="w-40">
        <DropdownMenuRadioGroup
          value={backend}
          onValueChange={(value) =>
            applyBackend(clampRendererBackendPreference(value))
          }
        >
          {(Object.keys(RENDERER_LABELS) as RendererBackendPreference[]).map(
            (value) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                text={RENDERER_LABELS[value]}
              />
            )
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
