/**
 * useServerHealth — polls BrainstormServer health endpoint.
 * Shows connection status in the UI so the user knows if the backend is running.
 */

import { useState, useEffect, useCallback } from "react";
import { isBackendAlive } from "../lib/ipc-client";
import type { HealthResponse } from "../lib/api-client";
import { useBackendRecovery } from "./useBackendRecovery";

export interface ServerHealthState {
  connected: boolean;
  health: HealthResponse | null;
  checking: boolean;
  lastCheck: number | null;
  error: string | null;
}

export function useServerHealth(pollIntervalMs = 10_000): ServerHealthState & {
  check: () => void;
} {
  const [state, setState] = useState<ServerHealthState>({
    connected: false,
    health: null,
    checking: true,
    lastCheck: null,
    error: null,
  });

  const check = useCallback(async () => {
    setState((prev) => ({ ...prev, checking: true }));
    const alive = await isBackendAlive();

    setState({
      connected: alive,
      health: alive
        ? {
            status: "healthy",
            version: "",
            uptime_seconds: 0,
            god_mode: { connected: 0, tools: 0 },
            conversations: { active: 0 },
          }
        : null,
      checking: false,
      lastCheck: Date.now(),
      error: alive ? null : "Backend process not responding",
    });
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, pollIntervalMs);
    return () => clearInterval(interval);
  }, [check, pollIntervalMs]);
  // Don't wait up to pollIntervalMs to flip "connected" back to true after
  // a respawn — the backend-ready signal arrives within ~1s of recovery.
  useBackendRecovery(check);

  return { ...state, check };
}
