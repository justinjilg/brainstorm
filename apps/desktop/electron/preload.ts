/**
 * Preload — exposes a safe IPC bridge to the renderer process.
 * The renderer calls window.brainstorm.request() / .chatStream().
 *
 * IMPORTANT: This source must stay in sync with electron/dist/preload.cjs.
 * The .cjs file is what actually runs (Electron preload requires CommonJS).
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("brainstorm", {
  /** Send a request and get a response. */
  request: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke("request", method, params),

  /** Start a chat stream. Returns promise that resolves when stream ends. */
  chatStream: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("chat-stream", params),

  /** Listen for chat stream events. Returns an unlisten function. */
  onChatEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data);
    ipcRenderer.on("chat-event", handler);
    return () => ipcRenderer.removeListener("chat-event", handler);
  },

  /**
   * Listen for backend-ready events. Fires on both the initial boot and
   * after a crash+respawn recovery — the payload carries `recovery: true`
   * only in the recovery case, so hooks that already loaded at mount can
   * refetch selectively. Returns an unlisten function.
   */
  onBackendReady: (callback: (payload: { recovery: boolean }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { recovery: boolean },
    ) => callback(data);
    ipcRenderer.on("backend-ready", handler);
    return () => ipcRenderer.removeListener("backend-ready", handler);
  },

  /** Open a native folder picker dialog. */
  openFolder: () => ipcRenderer.invoke("open-folder"),

  /** Open folder picker, walk up looking for business.toml, return
   * discriminated result. See harness-types.ts#OpenDialogResult. */
  openHarnessDialog: () => ipcRenderer.invoke("harness.openDialog"),

  /** Detect a harness at or above the given path. */
  detectHarness: (path: string) => ipcRenderer.invoke("harness.detect", path),

  /** Re-parse a harness's business.toml. */
  parseHarness: (root: string) => ipcRenderer.invoke("harness.parse", root),

  /** Open the index session for a harness root. Runs cold-open verify
   *  and returns drift counts (clean/stale/missing) for UI display. */
  openHarnessSession: (root: string) =>
    ipcRenderer.invoke("harness.openSession", root),

  /** Close the active index session. Called on harness close. */
  closeHarnessSession: () => ipcRenderer.invoke("harness.closeSession"),
});
