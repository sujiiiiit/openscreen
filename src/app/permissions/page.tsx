"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AccessIcon,
  Camera01Icon,
  ComputerScreenShareIcon,
  Mic01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import type {
  MacPermissionKind,
  MacPermissionState,
  PermissionSnapshot,
  RequiredMacPermissionKind,
} from "@/types/api"

const PERMISSIONS: Array<{
  kind: RequiredMacPermissionKind
  title: string
  description: string
  icon: typeof ComputerScreenShareIcon
}> = [
  {
    kind: "screen",
    title: "Screen Recording",
    description: "Capture your display.",
    icon: ComputerScreenShareIcon,
  },
  {
    kind: "microphone",
    title: "Microphone",
    description: "Record your voice.",
    icon: Mic01Icon,
  },
  {
    kind: "camera",
    title: "Camera",
    description: "Show your face overlay.",
    icon: Camera01Icon,
  },
  {
    kind: "accessibility",
    title: "Accessibility",
    description: "Detect keyboard shortcuts.",
    icon: AccessIcon,
  },
]

const EMPTY_SNAPSHOT: PermissionSnapshot = {
  permissions: {
    screen: "unknown",
    systemAudio: "unknown",
    microphone: "unknown",
    camera: "unknown",
    accessibility: "unknown",
  },
  required: ["screen", "microphone", "camera", "accessibility"],
  missing: ["screen", "microphone", "camera", "accessibility"],
  allGranted: false,
  checkedAt: 0,
}

export default function PermissionsPage() {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot>(EMPTY_SNAPSHOT)
  const [busyKind, setBusyKind] = useState<MacPermissionKind | "all" | null>(null)

  useEffect(() => {
    let mounted = true

    if (!window.api?.permissions) return undefined

    window.api.permissions.getStatus().then((next) => {
      if (mounted) setSnapshot(next)
    })

    const unsubscribe = window.api.permissions.onChanged((event) => {
      setSnapshot(event.snapshot)
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  async function requestPermission(kind: MacPermissionKind) {
    if (!window.api?.permissions) return
    if (snapshot.permissions[kind] === "granted") return
    setBusyKind(kind)
    try {
      setSnapshot(await window.api.permissions.request(kind))
    } finally {
      setBusyKind(null)
    }
  }

  async function closeWindow() {
    await window.api?.permissions?.closeWindow()
  }

  return (
    <main
      data-window="permission"
      className="flex h-screen w-screen flex-col text-foreground select-none bg-transparent"
      style={DRAG}
    >
      <header className="p-5">
        <h1 className="text-[15px] font-semibold leading-tight">Permissions</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          OpenScreen needs access to record your screen.
        </p>
      </header>

      <ul className="flex-1 px-5">
        {PERMISSIONS.map((permission) => {
          const state: MacPermissionState = snapshot.permissions[permission.kind]
          const isGranted = state === "granted"
          const isBusy = busyKind === permission.kind || busyKind === "all"
          const isDisabled = isBusy || isGranted || state === "restricted"
          return (
            <li
              key={permission.kind}
              className="border-b border-border/60 last:border-b-0"
              style={NO_DRAG}
            >
              <label className="flex items-center gap-3 py-3">
                <HugeiconsIcon
                  icon={permission.icon}
                  size={18}
                  color="currentColor"
                  className="text-muted-foreground"
                />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="text-[13px] font-medium">{permission.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {permission.description}
                  </p>
                </div>
                <Switch
                  checked={isGranted}
                  disabled={isDisabled}
                  onCheckedChange={() => requestPermission(permission.kind)}
                  aria-label={`${permission.title} permission`}
                />
              </label>
            </li>
          )
        })}
      </ul>

      <footer className="flex justify-end px-5 pt-3 pb-5">
        <Button type="button" size="sm" onClick={closeWindow}>
          Close
        </Button>
      </footer>
    </main>
  )
}
