import { useEffect, useRef } from "react";

/**
 * Call `onRecovery` every time the backend respawns after a crash.
 *
 * Used by data hooks (useConversations, useTools, useMemory, useSkills,
 * useConfig, useModels) so they don't sit on pre-crash cached state
 * indefinitely. The signal distinguishes initial boot (`recovery: false`
 * — the hook's mount-time fetch handles it) from recovery (`recovery:
 * true` — the hook should refetch).
 *
 * Safe to mount on a page that will unmount before the backend dies —
 * the returned unlisten in the preload bridge removes the listener.
 *
 * Falls back to a no-op in browser dev mode (no window.brainstorm),
 * which matches the HTTP-fallback polling strategy useServerHealth uses.
 */
export function useBackendRecovery(onRecovery: () => void): void {
  // Keep a stable ref to the callback so updates don't churn the
  // subscription. Missing this caused a listener to be added/removed on
  // every parent render when callers passed inline functions.
  const cbRef = useRef(onRecovery);
  useEffect(() => {
    cbRef.current = onRecovery;
  }, [onRecovery]);

  useEffect(() => {
    const bridge = window.brainstorm;
    if (!bridge?.onBackendReady) return;
    const off = bridge.onBackendReady(({ recovery }) => {
      if (recovery) cbRef.current();
    });
    return off;
  }, []);
}
