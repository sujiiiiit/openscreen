import * as React from "react"
import { cn } from "@/lib/utils"

interface RecordIconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number
}

export function RecordIcon({
  size = 32,
  className,
  ...props
}: RecordIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Record"
      className={cn("text-muted-foreground", className)}
      {...props}
    >
      <g fill="currentColor">
        <path d="M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6" />
        <path
          fillRule="evenodd"
          d="M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2s10 4.477 10 10m-2 0a8 8 0 1 1-16 0a8 8 0 0 1 16 0"
          clipRule="evenodd"
        />
      </g>
    </svg>
  )
}
