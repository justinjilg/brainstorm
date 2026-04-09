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

export function useKairos() {
  const [state, setState] = useState<KairosState>({
    status: "stopped",
    tickCount: 0,
    totalCost: 0,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await request<KairosState>("kairos.status");
      setState(s);
    } catch {
      setState({ status: "stopped", tickCount: 0, totalCost: 0 });
    }
  }, []);

  const start = useCallback(async () => {
    try {
      await request("kairos.start");
      // Start polling for status updates
      pollRef.current = setInterval(refresh, 3000);
      refresh();
    } catch (err) {
      console.error("Failed to start KAIROS:", err);
    }
  }, [refresh]);

  const stop = useCallback(async () => {
    try {
      await request("kairos.stop");
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setState({ status: "stopped", tickCount: 0, totalCost: 0 });
    } catch {
      // Already stopped
    }
  }, []);

  const pause = useCallback(async () => {
    try {
      await request("kairos.pause");
      refresh();
    } catch {
      // Not running
    }
  }, [refresh]);

  const resume = useCallback(async () => {
    try {
      await request("kairos.resume");
      refresh();
    } catch {
      // Not running
    }
  }, [refresh]);

  // Check initial status on mount
  useEffect(() => {
    refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  return { ...state, start, stop, pause, resume, refresh };
}
