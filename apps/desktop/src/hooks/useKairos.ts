/**
 * useKairos — controls the KAIROS daemon and reports its live state.
 *
 * Live status/tick/cost come from the organism bus (`useOrganism`), NOT a poll:
 * the daemon publishes its heartbeat to the bus and every surface folds the
 * stream. This hook keeps only the imperative controls (start/stop/pause/resume)
 * and the once-per-launch auto-ignition latch.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { request } from "../lib/ipc-client";
import { useOrganism } from "./useOrganism";
import type { KairosStatus as OrganismKairosStatus } from "../lib/organism";

export type KairosStatus = "running" | "sleeping" | "paused" | "stopped";

export interface KairosState {
  status: KairosStatus;
  tickCount: number;
  totalCost: number;
  sleepReason?: string;
  lastTickAt?: number;
}

/** Map the organism's KAIROS status onto this hook's display status. The bus
 * folds `sleep` as still-running, so there's no distinct "sleeping" state. */
function mapStatus(s: OrganismKairosStatus): KairosStatus {
  switch (s) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "idle":
    case "stopped":
    case "halted":
    default:
      return "stopped";
  }
}

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
  const { state: organism, connected } = useOrganism();
  const [error, setError] = useState<string | null>(null);
  // Latch: once we auto-ignite (or the user touches the controls), we never
  // auto-start again — stopping KAIROS must stay stopped.
  const autoStartLatchedRef = useRef(false);

  const status = mapStatus(organism.kairos.status);
  const state: KairosState = {
    status,
    tickCount: organism.kairos.tickCount,
    totalCost: organism.kairos.totalCost,
    lastTickAt: organism.kairos.lastTickAt,
  };

  const start = useCallback(async () => {
    autoStartLatchedRef.current = true;
    try {
      await request("kairos.start");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start KAIROS");
    }
  }, []);

  const stop = useCallback(async () => {
    autoStartLatchedRef.current = true;
    try {
      await request("kairos.stop");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop KAIROS");
    }
  }, []);

  const pause = useCallback(async () => {
    try {
      await request("kairos.pause");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pause KAIROS");
    }
  }, []);

  const resume = useCallback(async () => {
    try {
      await request("kairos.resume");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume KAIROS");
    }
  }, []);

  // Kept for API compatibility — live state now flows from the bus, so a
  // one-shot status request is enough to nudge an update if a caller asks.
  const refresh = useCallback(async () => {
    try {
      await request("kairos.status");
      setError(null);
    } catch {
      /* non-fatal — the bus remains the source of truth */
    }
  }, []);

  // Auto-ignition: the moment the organism snapshot confirms a fresh, stopped
  // daemon and the caller has cleared us to launch (backend ready), fire KAIROS
  // once so the system comes alive on open with no user prompt. The latch
  // guarantees this happens at most once and never re-fights a user who
  // subsequently stops it.
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartLatchedRef.current) return;
    if (!connected) return; // wait for a real snapshot, not the default state
    if (status !== "stopped") {
      // Already running (e.g. a prior in-process daemon) — nothing to ignite,
      // but latch so we treat this session as decided.
      autoStartLatchedRef.current = true;
      return;
    }
    autoStartLatchedRef.current = true;
    void start();
  }, [autoStart, connected, status, start]);

  return { ...state, error, start, stop, pause, resume, refresh };
}
