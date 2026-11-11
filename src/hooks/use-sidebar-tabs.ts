import { useCallback, useReducer } from "react";

interface UseSidebarTabsOptions {
  defaultOpen?: boolean;
}

type State<TTab extends string> = {
  activeTab: TTab;
  isOpen: boolean;
};

type Action<TTab extends string> =
  | { type: "select"; tab: TTab }
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "restore"; tab: TTab; isOpen: boolean };

function reducer<TTab extends string>(
  state: State<TTab>,
  action: Action<TTab>,
): State<TTab> {
  switch (action.type) {
    case "select":
      if (state.activeTab === action.tab) {
        return { ...state, isOpen: !state.isOpen };
      }
      return { activeTab: action.tab, isOpen: true };
    case "open":
      return state.isOpen ? state : { ...state, isOpen: true };
    case "close":
      return state.isOpen ? { ...state, isOpen: false } : state;
    case "toggle":
      return { ...state, isOpen: !state.isOpen };
    case "restore":
      // Unlike "select", sets both fields verbatim (no same-tab toggle) —
      // used to rehydrate persisted state. Bails when nothing changes so a
      // restore matching the defaults causes no re-render.
      if (state.activeTab === action.tab && state.isOpen === action.isOpen) {
        return state;
      }
      return { activeTab: action.tab, isOpen: action.isOpen };
  }
}

export function useSidebarTabs<TTab extends string>(
  initialTab: TTab,
  options?: UseSidebarTabsOptions,
) {
  const [state, dispatch] = useReducer(
    reducer as (state: State<TTab>, action: Action<TTab>) => State<TTab>,
    undefined,
    () => ({
      activeTab: initialTab,
      isOpen: options?.defaultOpen ?? true,
    }),
  );

  const selectTab = useCallback(
    (tab: TTab) => dispatch({ type: "select", tab }),
    [],
  );
  const open = useCallback(() => dispatch({ type: "open" }), []);
  const close = useCallback(() => dispatch({ type: "close" }), []);
  const toggle = useCallback(() => dispatch({ type: "toggle" }), []);
  const restore = useCallback(
    (tab: TTab, isOpen: boolean) => dispatch({ type: "restore", tab, isOpen }),
    [],
  );

  return {
    activeTab: state.activeTab,
    isOpen: state.isOpen,
    selectTab,
    open,
    close,
    toggle,
    restore,
  } as const;
}
