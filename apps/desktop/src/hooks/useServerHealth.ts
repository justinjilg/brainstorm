/**
 * useServerHealth — reports whether the backend is alive.
 *
 * Liveness comes from the organism bus: once the `organism.subscribe` snapshot
 * arrives (`useOrganism().connected`), the backend is up — no interval poll. A
 * one-shot `health` probe on mount (and on backend-recovery) covers the window
 * before the first snapshot and provides the richer status payload.
 */

import { useState, useEffect, useCallback } from "react";
import { isBackendAlive } from "../lib/ipc-client";
import type { HealthResponse } from "../lib/api-client";
import { useBackendRecovery } from "./useBackendRecovery";
import { useOrganism } from "./useOrganism";

export interface ServerHealthState {
  connected: boolean;
  health: HealthResponse | null;
  checking: boolean;
  lastCheck: number | null;
  error: string | null;
}

export function useServerHealth(): ServerHealthState & {
  check: () => void;
} {
  const { connected: organismConnected } = useOrganism();
  const [probe, setProbe] = useState<{
    alive: boolean;
    checked: boolean;
    at: number | null;
  }>({ alive: false, checked: false, at: null });

  const check = useCallback(async () => {
    const alive = await isBackendAlive();
    setProbe({ alive, checked: true, at: Date.now() });
  }, []);

  // One-shot on mount; the organism snapshot handles steady-state liveness.
  useEffect(() => {
    check();
  }, [check]);
  // Don't wait for a snapshot to flip "connected" back to true after a respawn —
  // the backend-ready signal arrives within ~1s of recovery.
  useBackendRecovery(check);

  // Either signal proves the backend is up: the live organism stream or the
  // one-shot probe.
  const connected = organismConnected || probe.alive;
  const checking = !probe.checked && !organismConnected;

  return {
    connected,
    health: connected
      ? {
          status: "healthy",
          version: "",
          uptime_seconds: 0,
          god_mode: { connected: 0, tools: 0 },
          conversations: { active: 0 },
        }
      : null,
    checking,
    lastCheck: probe.at,
    error: connected
      ? null
      : probe.checked
        ? "Backend process not responding"
        : null,
    check,
  };
}
