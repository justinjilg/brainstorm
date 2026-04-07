/**
 * useServerHealth — polls BrainstormServer health endpoint.
 * Shows connection status in the UI so the user knows if the backend is running.
 */

import { useState, useEffect, useCallback } from "react";
import { getClient, type HealthResponse } from "../lib/api-client";

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
    const client = getClient();
    const health = await client.health();

    setState({
      connected: health !== null,
      health,
      checking: false,
      lastCheck: Date.now(),
      error:
        health === null ? "Cannot reach BrainstormServer on port 3100" : null,
    });
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, pollIntervalMs);
    return () => clearInterval(interval);
  }, [check, pollIntervalMs]);

  return { ...state, check };
}
