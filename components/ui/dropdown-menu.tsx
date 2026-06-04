"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { NO_DRAG } from "@/lib/window-drag"

// ─── Shared ────────────────────────────────────────────────────────────────

const itemCn =
  "focus:bg-accent min-h-7 py-1.5 gap-4 w-full text-sm leading-[1.2] rounded-lg px-2 pl-2.5 data-inset:pl-7 [&_svg:not([class*='size-'])]:size-4 group/dropdown-menu-item relative flex items-center outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 font-medium justify-start"

type ItemSharedProps = {
  inset?: boolean
  icon?: React.ReactNode
  text?: string
  subtext?: string
  shortcut?: string | React.ReactNode
  badge?: React.ReactNode
}

function ItemContent({
  icon,
  text,
  subtext,
  shortcut,
  badge,
  children,
}: ItemSharedProps & { children?: React.ReactNode }) {
  return (
    <>
      {icon && <span className="[&_svg]:size-3.5!">{icon}</span>}
      <div className="flex h-full min-w-0 flex-1 items-center justify-between gap-2">
        {text && (
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span className="truncate">{text}</span>
            {badge}
          </div>
        )}
        {subtext && (
          <div
            data-slot="dropdown-menu-item-subtext"
            className="text-muted-foreground mr-1 ml-auto text-sm leading-[1.2] text-nowrap"
          >
            {subtext}
          </div>
        )}
        {shortcut && (
          <span className="text-muted-foreground ml-auto shrink-0 pl-4 text-xs">
            {shortcut}
          </span>
        )}
      </div>
      {children}
    </>
  )
}

// ─── Positioner defaults ────────────────────────────────────────────────────

type PositionerProps = Pick<
  MenuPrimitive.Positioner.Props,
  "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
>

// ─── Components ────────────────────────────────────────────────────────────

const DropdownMenu = MenuPrimitive.Root
const DropdownMenuPortal = MenuPrimitive.Portal
const DropdownMenuGroup = MenuPrimitive.Group
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

type DropdownMenuTriggerProps = MenuPrimitive.Trigger.Props & {
  asChild?: boolean
}

function DropdownMenuTrigger({
  asChild,
  children,
  render,
  ...props
}: DropdownMenuTriggerProps) {
  if (asChild && React.isValidElement(children)) {
    return <MenuPrimitive.Trigger render={children} {...props} />
  }

  return (
    <MenuPrimitive.Trigger render={render} {...props}>
      {children}
    </MenuPrimitive.Trigger>
  )
}

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.Separator.Props
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    data-slot="dropdown-menu-separator"
    className={cn("bg-border/50 mx-1 my-1 h-px", className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = "DropdownMenuSeparator"

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("text-muted-foreground text-xs", className)}
      {...props}
    />
  )
}

// ─── Content / Popup ───────────────────────────────────────────────────────

type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  PositionerProps & { "data-slot"?: string; zIndex?: number | string }

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  anchor,
  className,
  zIndex,
  style,
  ...props
}: DropdownMenuContentProps) {
  const positionerClassName = zIndex ? "isolate outline-none" : "isolate z-50 outline-none"

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className={positionerClassName}
        style={zIndex ? { zIndex } : undefined}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
      >
        <MenuPrimitive.Popup
          autoFocus={false}
          data-slot={props["data-slot"] ?? "dropdown-menu-content"}
          className={cn(
            "bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            "z-50 max-h-(--available-height) w-max max-w-72 min-w-45 origin-(--transform-origin) gap-px overflow-y-auto rounded-xl p-1.5 outline-none",
            "[&:has([data-slot=dropdown-menu-sub-trigger],[data-slot=dropdown-menu-radio-item],[data-slot=dropdown-menu-checkbox-item])_[data-slot=dropdown-menu-item]_[data-slot=dropdown-menu-item-subtext]]:mr-9",
            className
          )}
          // Menus pop OVER the titlebar drag region — without NO_DRAG,
          // mousedown on a menu item gets swallowed by the OS window-drag
          // handler and the click never fires.
          style={{ ...NO_DRAG, ...style }}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: DropdownMenuContentProps) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10 w-auto max-w-72 min-w-24 rounded-xl p-1",
        className
      )}
      {...props}
    />
  )
}

// ─── Label ─────────────────────────────────────────────────────────────────

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "text-muted-foreground pointer-events-none px-2 py-1.5 text-xs font-medium select-none data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

// ─── Item ──────────────────────────────────────────────────────────────────

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  icon,
  text,
  subtext,
  shortcut,
  badge,
  children,
  ...props
}: MenuPrimitive.Item.Props &
  ItemSharedProps & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      closeOnClick={true}
      className={cn(
        itemCn,
        "flex-nowrap",
        variant === "destructive" && [
          "text-destructive",
          "focus:bg-destructive/10",
          "dark:focus:bg-destructive/20",
        ],
        className
      )}
      {...props}
    >
      <ItemContent icon={icon} text={text} subtext={subtext} shortcut={shortcut} badge={badge}>
        {children}
      </ItemContent>
    </MenuPrimitive.Item>
  )
}

// ─── Sub ───────────────────────────────────────────────────────────────────

const DropdownMenuSub = MenuPrimitive.SubmenuRoot

function DropdownMenuSubTrigger({
  className,
  inset,
  icon,
  text,
  subtext,
  shortcut,
  badge,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & ItemSharedProps) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        itemCn,
        "data-open:bg-accent data-popup-open:bg-accent",
        className
      )}
      {...props}
    >
      <ItemContent icon={icon} text={text} subtext={subtext} shortcut={shortcut} badge={badge}>
        {children}
      </ItemContent>
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="text-muted-foreground ml-auto shrink-0 size-4" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

// ─── Indicator wrappers ─────────────────────────────────────────────────────

function CheckIndicator({ slot }: { slot: string }) {
  return (
    <span
      className="text-muted-foreground pointer-events-none ml-auto flex size-4 shrink-0 items-center justify-center"
      data-slot={slot}
    >
      <MenuPrimitive.CheckboxItemIndicator>
        <HugeiconsIcon icon={Tick02Icon} />
      </MenuPrimitive.CheckboxItemIndicator>
    </span>
  )
}

function RadioIndicator({ slot }: { slot: string }) {
  return (
    <span
      className="text-muted-foreground pointer-events-none flex size-4 shrink-0 items-center justify-center"
      data-slot={slot}
    >
      <MenuPrimitive.RadioItemIndicator>
        <HugeiconsIcon icon={Tick02Icon} />
      </MenuPrimitive.RadioItemIndicator>
    </span>
  )
}

// ─── Checkbox item ─────────────────────────────────────────────────────────

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  icon,
  text,
  subtext,
  shortcut,
  badge,
  ...props
}: MenuPrimitive.CheckboxItem.Props & ItemSharedProps) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(itemCn, className)}
      checked={checked}
      closeOnClick={false}
      {...props}
    >
      <ItemContent icon={icon} text={text} subtext={subtext} shortcut={shortcut} badge={badge}>
        {children}
      </ItemContent>
      <CheckIndicator slot="dropdown-menu-checkbox-item-indicator" />
    </MenuPrimitive.CheckboxItem>
  )
}

// ─── Radio item ────────────────────────────────────────────────────────────

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  icon,
  text,
  subtext,
  shortcut,
  badge,
  ...props
}: MenuPrimitive.RadioItem.Props & ItemSharedProps) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(itemCn, className)}
      closeOnClick={true}
      {...props}
    >
      <ItemContent icon={icon} text={text} subtext={subtext} shortcut={shortcut} badge={badge}>
        {children}
      </ItemContent>
      <RadioIndicator slot="dropdown-menu-radio-item-indicator" />
    </MenuPrimitive.RadioItem>
  )
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  itemCn,
  ItemContent,
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
