/**
 * Preload — exposes a safe IPC bridge to the renderer process.
 *
 * CommonJS because Electron's contextIsolation preload sandbox does not
 * support ESM. This file is the source of truth; `electron/preload.ts`
 * mirrors it for TypeScript type-checking only. The build pipeline
 * copies this file to electron/dist/preload.cjs — that's what
 * webPreferences.preload points at via main.ts.
 *
 * If you add a new ipcRenderer method here, update preload.ts and
 * src/global.d.ts so the renderer gets matching types.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brainstorm", {
  /** Send a request and get a response. */
  request: (method, params) => ipcRenderer.invoke("request", method, params),

  /** Start a chat stream. Returns promise that resolves when stream ends. */
  chatStream: (params) => ipcRenderer.invoke("chat-stream", params),

  /** Listen for chat stream events. Returns an unlisten function. */
  onChatEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("chat-event", handler);
    return () => ipcRenderer.removeListener("chat-event", handler);
  },

  /**
   * Listen for backend-ready events. Fires on both the initial boot and
   * after a crash+respawn recovery — the payload carries `recovery: true`
   * only in the recovery case, so hooks that already loaded at mount can
   * refetch selectively. Returns an unlisten function.
   */
  onBackendReady: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("backend-ready", handler);
    return () => ipcRenderer.removeListener("backend-ready", handler);
  },

  /** Open a native folder picker dialog. */
  openFolder: () => ipcRenderer.invoke("open-folder"),

  /** Open folder picker, walk up looking for business.toml, return
   * discriminated result. See src/lib/harness-types.ts#OpenDialogResult. */
  openHarnessDialog: () => ipcRenderer.invoke("harness.openDialog"),

  /** Detect a harness at or above the given path. */
  detectHarness: (path) => ipcRenderer.invoke("harness.detect", path),

  /** Re-parse a harness's business.toml. */
  parseHarness: (root) => ipcRenderer.invoke("harness.parse", root),

  /** Open the index session for a harness root. Runs cold-open verify
   *  and returns drift counts (clean/stale/missing) for UI display. */
  openHarnessSession: (root) =>
    ipcRenderer.invoke("harness.openSession", root),

  /** Close the active index session. Called on harness close. */
  closeHarnessSession: () => ipcRenderer.invoke("harness.closeSession"),

  /** List indexed artifacts whose relative_path starts with the folder slug.
   *  Backs the per-folder panels in BusinessHarnessView. */
  listHarnessFolder: (folderSlug) =>
    ipcRenderer.invoke("harness.listFolder", folderSlug),

  /**
   * Query main for the current sticky backendReady state. Used at mount
   * time by useBackendReady to resolve a race where the backend emits
   * its ready signal BEFORE React attaches the onBackendReady listener.
   * Returns a boolean promise.
   */
  getBackendReady: () => ipcRenderer.invoke("main.backend-ready-state"),
});
