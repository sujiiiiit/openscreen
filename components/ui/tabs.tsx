"use client";

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { motion } from "motion/react";

type TabsContextValue = {
  activeTab: string;
  setActiveTab: (value: string) => void;
  baseId: string;
  indicatorLayoutId: string;
  order: string[];
  registerValue: (value: string) => void;
  unregisterValue: (value: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs subcomponents must be rendered within <Tabs>.");
  }
  return context;
}

export const useTabs = useTabsContext;

type TabsProps<TValue extends string = string> = {
  defaultValue?: TValue;
  value?: TValue;
  onValueChange?: (value: TValue) => void;
  children: ReactNode;
  className?: string;
};

export function Tabs<TValue extends string = string>({
  defaultValue,
  value: controlledValue,
  onValueChange,
  children,
  className,
}: TabsProps<TValue>) {
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState<string>(
    defaultValue ?? "",
  );
  const activeTab = isControlled ? controlledValue : internalValue;

  const baseId = useId();
  const indicatorLayoutId = `${baseId}-indicator`;

  const [order, setOrder] = useState<string[]>([]);

  const registerValue = useCallback((value: string) => {
    setOrder((prev) => (prev.includes(value) ? prev : [...prev, value]));
  }, []);

  const unregisterValue = useCallback((value: string) => {
    setOrder((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : prev,
    );
  }, []);

  const setActiveTab = useCallback(
    (next: string) => {
      if (!isControlled) {
        setInternalValue((prev) => (prev === next ? prev : next));
      }
      onValueChange?.(next as TValue);
    },
    [isControlled, onValueChange],
  );

  const contextValue = useMemo<TabsContextValue>(
    () => ({
      activeTab,
      setActiveTab,
      baseId,
      indicatorLayoutId,
      order,
      registerValue,
      unregisterValue,
    }),
    [
      activeTab,
      setActiveTab,
      baseId,
      indicatorLayoutId,
      order,
      registerValue,
      unregisterValue,
    ],
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={`flex w-full flex-col gap-6 ${className ?? ""}`}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

type TabsListProps = {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
};

export function TabsList({
  children,
  className,
  "aria-label": ariaLabel,
}: TabsListProps) {
  const { activeTab, setActiveTab, order } = useTabsContext();
  const listRef = useRef<HTMLDivElement>(null);

  const focusTrigger = useCallback((value: string) => {
    const node = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-tabs-trigger="${CSS.escape(value)}"]`,
    );
    node?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (order.length === 0) return;
    const currentIndex = order.indexOf(activeTab);
    let nextIndex = currentIndex;

    switch (event.key) {
      case "ArrowRight":
        nextIndex =
          currentIndex < 0 ? 0 : (currentIndex + 1) % order.length;
        break;
      case "ArrowLeft":
        nextIndex =
          currentIndex < 0
            ? order.length - 1
            : (currentIndex - 1 + order.length) % order.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = order.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextValue = order[nextIndex];
    setActiveTab(nextValue);
    focusTrigger(nextValue);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={`flex items-center ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

type TabsTriggerProps = {
  value: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  asChild?: boolean;
};

type TriggerChildProps = {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
};

export function TabsTrigger({
  value,
  children,
  className,
  disabled,
  asChild,
}: TabsTriggerProps) {
  const {
    activeTab,
    setActiveTab,
    baseId,
    indicatorLayoutId,
    registerValue,
    unregisterValue,
  } = useTabsContext();
  const isActive = value === activeTab;

  useEffect(() => {
    registerValue(value);
    return () => unregisterValue(value);
  }, [value, registerValue, unregisterValue]);

  if (asChild && isValidElement(children)) {
    const child = Children.only(children) as ReactElement<TriggerChildProps>;
    const childProps = child.props;
    return cloneElement(child, {
      role: "tab",
      id: `${baseId}-tab-${value}`,
      "aria-selected": isActive,
      "aria-controls": `${baseId}-panel-${value}`,
      "data-state": isActive ? "active" : "inactive",
      "data-tabs-trigger": value,
      tabIndex: isActive ? 0 : -1,
      disabled,
      onClick: (event: MouseEvent<HTMLElement>) => {
        childProps.onClick?.(event);
        if (!event.defaultPrevented) setActiveTab(value);
      },
      className: [childProps.className, className].filter(Boolean).join(" "),
    } as Partial<TriggerChildProps> & Record<string, unknown>);
  }

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={isActive}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={isActive ? 0 : -1}
      disabled={disabled}
      data-tabs-trigger={value}
      onClick={() => setActiveTab(value)}
      className={`relative rounded-full px-4 py-2 text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none ${className ?? ""}`}
    >
      {isActive && (
        <motion.span
          layoutId={indicatorLayoutId}
          className="absolute inset-0 rounded-full bg-primary-active-bg"
          transition={{ type: "tween", duration: 0.2 }}
        />
      )}
      <span
        className={`relative z-10 ${isActive ? "text-primary-active" : "text-primary"}`}
      >
        {children}
      </span>
    </button>
  );
}

type TabsContentsProps = {
  children: ReactNode;
  className?: string;
};

// Stacking container for the panels. Required so inactive (absolutely
// positioned) panels are positioned against this box rather than escaping
// to an unrelated ancestor.
export function TabsContents({ children, className }: TabsContentsProps) {
  return (
    <div className={`relative w-full ${className ?? ""}`}>{children}</div>
  );
}

type TabsContentProps = {
  value: string;
  children: ReactNode;
  className?: string;
};

export function TabsContent({ value, children, className }: TabsContentProps) {
  const { activeTab, baseId, order, registerValue, unregisterValue } =
    useTabsContext();
  const isActive = value === activeTab;

  useEffect(() => {
    registerValue(value);
    return () => unregisterValue(value);
  }, [value, registerValue, unregisterValue]);

  const myIndex = order.indexOf(value);
  const activeIndex = order.indexOf(activeTab);

  const xOffset =
    isActive || activeIndex === -1 || myIndex === -1
      ? 0
      : myIndex > activeIndex
        ? 32
        : -32;

  return (
    <motion.div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!isActive}
      tabIndex={0}
      initial={false}
      animate={{
        opacity: isActive ? 1 : 0,
        x: xOffset,
        pointerEvents: isActive ? "auto" : "none",
      }}
      transition={{
        duration: 0.25,
        ease: "easeOut",
        opacity: { duration: isActive ? 0.25 : 0.15 },
      }}
      className={`w-full ${isActive ? "relative z-10" : "absolute inset-0"} ${className ?? ""}`}
    >
      {children}
    </motion.div>
  );
}
