/**
 * Mode state management for the multi-mode TUI.
 * Modes: chat (1), dashboard (2), models (3), config (4)
 */

import { useState, useCallback } from "react";

export type TUIMode = "chat" | "dashboard" | "models" | "config";

const MODE_ORDER: TUIMode[] = ["chat", "dashboard", "models", "config"];

export const MODE_LABELS: Record<
  TUIMode,
  { label: string; key: string; color: string }
> = {
  chat: { label: "Chat", key: "1", color: "green" },
  dashboard: { label: "Dashboard", key: "2", color: "blue" },
  models: { label: "Models", key: "3", color: "yellow" },
  config: { label: "Config", key: "4", color: "magenta" },
};

export function useMode(initial: TUIMode = "chat") {
  const [mode, setMode] = useState<TUIMode>(initial);

  const cycleMode = useCallback(() => {
    setMode((prev) => {
      const idx = MODE_ORDER.indexOf(prev);
      return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
    });
  }, []);

  const setModeByKey = useCallback((key: string): boolean => {
    const idx = parseInt(key, 10) - 1;
    if (idx >= 0 && idx < MODE_ORDER.length) {
      setMode(MODE_ORDER[idx]);
      return true;
    }
    return false;
  }, []);

  return { mode, setMode, cycleMode, setModeByKey };
}
