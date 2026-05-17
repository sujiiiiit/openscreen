import * as React from "react"
import { cn } from "@/lib/utils"

interface CheckIconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number
}

export function CheckIcon({
  size = 32,
  className,
  ...props
}: CheckIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Check"
      className={cn("text-muted-foreground", className)}
      {...props}
    >
      <path
        fill="currentColor"
        d="M20.285 2l-11.285 11.567-5.286-5.011-3.714 3.716 9 8.728 15-15.285z"
      />
    </svg>
  )
}
