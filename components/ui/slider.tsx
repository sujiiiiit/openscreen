import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const sliderTrackVariants = cva(
  "relative grow overflow-hidden rounded-full bg-input/90 select-none data-horizontal:w-full data-vertical:h-full",
  {
    variants: {
      size: {
        default: "data-horizontal:h-2 data-vertical:w-2",
        sm: "data-horizontal:h-0.5 data-vertical:w-0.5",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const sliderThumbVariants = cva(
  "block shrink-0 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-[color,box-shadow,background-color] select-none not-dark:bg-clip-padding hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-4 w-6 data-vertical:h-6 data-vertical:w-4",
        sm: "h-3 w-4 data-vertical:h-4 data-vertical:w-3",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

type SliderExtraProps = {
  showValueTooltip?: boolean
  formatValue?: (value: number) => string
}

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  size = "default",
  showValueTooltip = false,
  formatValue,
  ...props
}: SliderPrimitive.Root.Props &
  VariantProps<typeof sliderTrackVariants> &
  SliderExtraProps) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(sliderTrackVariants({ size }))}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => {
          const numericValue = _values[index]
          const formatted = formatValue
            ? formatValue(numericValue)
            : String(Math.round(numericValue))
          return (
            <SliderPrimitive.Thumb
              data-slot="slider-thumb"
              key={index}
              className={cn(
                sliderThumbVariants({ size }),
                showValueTooltip && "group/slider-thumb relative"
              )}
            >
              {showValueTooltip ? (
                <span
                  data-slot="slider-value-tooltip"
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 scale-95 rounded-md bg-foreground px-2 py-0.5 text-[10px] font-medium text-background tabular-nums whitespace-nowrap opacity-0 shadow-md ring-1 ring-black/10 transition-[opacity,transform] duration-150 group-data-dragging/slider-thumb:scale-100 group-data-dragging/slider-thumb:opacity-100 group-focus-within/slider-thumb:scale-100 group-focus-within/slider-thumb:opacity-100"
                >
                  {formatted}
                </span>
              ) : null}
            </SliderPrimitive.Thumb>
          )
        })}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider, sliderTrackVariants, sliderThumbVariants }
