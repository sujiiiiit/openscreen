"use client"

import { useId } from "react"

import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/**
 * A titled group of related controls inside a sidebar panel (e.g. Cursor →
 * Appearance / Behavior / Typing / Motion). Groups after the first are divided
 * by a hairline so a long panel scans as a few sections, not one long list.
 */
export function PanelGroup({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "flex w-full flex-col gap-6 border-t border-border/60 pt-5 first:border-t-0 first:pt-0",
        className
      )}
    >
      <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase select-none">
        {title}
      </h4>
      {children}
    </section>
  )
}

/** A labelled on/off setting with an optional one-line description. */
export function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const switchId = useId()
  return (
    <div className="flex w-full items-start justify-between gap-3">
      <div
        className={cn(
          "space-y-1 transition-opacity select-none",
          disabled && "opacity-50"
        )}
      >
        <label htmlFor={switchId} className="text-xs font-semibold">
          {label}
        </label>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch
        id={switchId}
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  )
}
