/**
 * useKairos — controls the KAIROS daemon via IPC.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { request } from "../lib/ipc-client";

export type KairosStatus = "running" | "sleeping" | "paused" | "stopped";

export interface KairosState {
  status: KairosStatus;
  tickCount: number;
  totalCost: number;
  sleepReason?: string;
  lastTickAt?: number;
}

const POLL_INTERVAL_MS = 3000;

export interface UseKairosOptions {
  /**
   * When true, ignite the daemon automatically the first time we confirm it is
   * stopped (fresh launch). This is the "flip defaults ON" of the awakening
   * slice — the system comes alive on open, bounces off the available models,
   * and runs its connectivity + self-healing loop with no user prompt. Fires
   * at most once per mount and never re-fights a user who then stops it.
   */
  autoStart?: boolean;
}

export function useKairos(options: UseKairosOptions = {}) {
  const { autoStart = false } = options;
  const [state, setState] = useState<KairosState>({
    status: "stopped",
    tickCount: 0,
    totalCost: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latch: once we auto-ignite (or the user touches the controls), we never
  // auto-start again — stopping KAIROS must stay stopped.
  const autoStartLatchedRef = useRef(false);
  // Set true only after a real status fetch succeeds, so auto-ignition waits
  // for a genuine "stopped" from the backend rather than the default state.
  const [statusConfirmed, setStatusConfirmed] = useState(false);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPoll = useCallback((doRefresh: () => void) => {
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(doRefresh, POLL_INTERVAL_MS);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await request<KairosState>("kairos.status");
      setState(s);
      setError(null);
      setStatusConfirmed(true);
      // Start polling automatically when the daemon is active, whether the
      // user started it in this session or it was already running from a
      // prior CLI session. Pre-fix the app only began polling if the user
      // clicked Start in the current session — an already-running daemon
      // showed a frozen tick count that never updated.
      if (s.status !== "stopped") {
        startPoll(refresh);
      } else {
        clearPoll();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch status";
      setError(msg);
      setState({ status: "stopped", tickCount: 0, totalCost: 0 });
    }
  }, [startPoll, clearPoll]);

  const start = useCallback(async () => {
    autoStartLatchedRef.current = true;
    try {
      await request("kairos.start");
      setError(null);
      startPoll(refresh);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start KAIROS");
    }
  }, [refresh, startPoll]);

  const stop = useCallback(async () => {
    autoStartLatchedRef.current = true;
    try {
      await request("kairos.stop");
      clearPoll();
      setState({ status: "stopped", tickCount: 0, totalCost: 0 });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop KAIROS");
    }
  }, [clearPoll]);

  const pause = useCallback(async () => {
    try {
      await request("kairos.pause");
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pause KAIROS");
    }
  }, [refresh]);

  const resume = useCallback(async () => {
    try {
      await request("kairos.resume");
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume KAIROS");
    }
  }, [refresh]);

  // Check initial status on mount. refresh() handles the
  // start-polling-if-already-running case, so no separate bootstrap.
  useEffect(() => {
    refresh();
    return clearPoll;
  }, [refresh, clearPoll]);

  // Auto-ignition: the moment we confirm a fresh, stopped daemon and the caller
  // has cleared us to launch (backend ready), fire KAIROS once so the system
  // comes alive on open with no user prompt. The latch guarantees this happens
  // at most once and never re-fights a user who subsequently stops it.
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartLatchedRef.current) return;
    if (!statusConfirmed) return;
    if (state.status !== "stopped") {
      // Already running (e.g. a prior CLI session) — nothing to ignite, but
      // latch so we treat this session as decided.
      autoStartLatchedRef.current = true;
      return;
    }
    autoStartLatchedRef.current = true;
    void start();
  }, [autoStart, statusConfirmed, state.status, start]);

  return { ...state, error, start, stop, pause, resume, refresh };
}
