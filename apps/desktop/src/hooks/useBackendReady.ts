import { useEffect, useState } from "react";

/**
 * Track the initial backend-ready signal.
 *
 * Before this hook existed, App.tsx had no distinct "backend booting"
 * state — views mounted immediately, fired their IPC calls, and timed
 * out at 30s because the child process wasn't ready yet. This produced
 * a ~1–2s window where the UI looked broken ("Failed to load tools",
 * empty lists everywhere) that actually reflected the backend just
 * starting up.
 *
 * We treat "ready" as sticky: once the main process has emitted at
 * least one ready event, `ready` stays true even during later
 * crash/respawn cycles (those are handled by useBackendRecovery, which
 * triggers refetches but doesn't revert the splash).
 *
 * In browser dev mode (no window.brainstorm bridge) we default to
 * ready=true because the HTTP-fallback path has its own health check.
 */
export function useBackendReady(): boolean {
  const [ready, setReady] = useState<boolean>(() => {
    // No Electron bridge → HTTP fallback path → no splash needed.
    return typeof window !== "undefined" && !window.brainstorm;
  });

  useEffect(() => {
    const bridge = window.brainstorm;
    if (!bridge?.onBackendReady) return;

    // Race resolution: main emits "backend-ready" on did-finish-load,
    // which can land BEFORE this useEffect runs (effects flush after
    // the first commit, but Electron's did-finish-load can fire at the
    // same moment). Poll the main-side sticky flag at mount so we
    // don't wait forever for an event we already missed.
    bridge.getBackendReady?.().then((alreadyReady) => {
      if (alreadyReady) setReady(true);
    });

    const off = bridge.onBackendReady(() => setReady(true));
    return off;
  }, []);

  return ready;
}
