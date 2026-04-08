/**
 * useSidecar — manages the BrainstormServer sidecar process via Tauri commands.
 */

import { useState, useCallback } from "react";

interface SidecarState {
  starting: boolean;
  error: string | null;
  message: string | null;
}

export function useSidecar() {
  const [state, setState] = useState<SidecarState>({
    starting: false,
    error: null,
    message: null,
  });

  const startServer = useCallback(async () => {
    setState({ starting: true, error: null, message: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("start_server");
      setState({ starting: false, error: null, message: result as string });
    } catch (err) {
      setState({
        starting: false,
        error: err instanceof Error ? err.message : String(err),
        message: null,
      });
    }
  }, []);

  const stopServer = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("stop_server");
      setState({ starting: false, error: null, message: "Server stopped" });
    } catch {
      // Ignore stop errors
    }
  }, []);

  return { ...state, startServer, stopServer };
}
