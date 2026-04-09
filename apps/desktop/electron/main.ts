/**
 * Electron Main Process — spawns brainstorm ipc as a child process.
 *
 * Uses the same NDJSON stdio protocol we built for Tauri, but now
 * Electron's main process manages the child instead of Rust.
 * This avoids native module rebuild issues (better-sqlite3 runs
 * in the child's regular Node.js, not Electron's modified V8).
 */

import { app, BrowserWindow, ipcMain, dialog, session } from "electron";
import { autoUpdater } from "electron-updater";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Backend process management ───────────────────────────────────

let backend: ChildProcess | null = null;
let backendReady = false;
let spawnRetries = 0;
const pending = new Map<string, (value: any) => void>();
let nextId = 1;

function sendToBackend(msg: Record<string, unknown>): void {
  if (backend?.stdin?.writable) {
    backend.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function spawnBackend(): void {
  // Find brainstorm CLI — try global install first, then npx
  const cmd = process.platform === "win32" ? "brainstorm.cmd" : "brainstorm";

  backend = spawn(cmd, ["ipc"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!backend.stdout || !backend.stdin) {
    console.error("Failed to capture backend stdio");
    // Try npx fallback
    backend = spawn("npx", ["brainstorm", "ipc"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  if (!backend.stdout) return;

  const rl = createInterface({ input: backend.stdout });

  rl.on("line", (line: string) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip non-JSON lines (pino logs, etc.)
    }

    const id = msg.id;

    if (msg.event) {
      // Streaming event — forward to all renderer windows
      const wins = BrowserWindow.getAllWindows();
      for (const win of wins) {
        win.webContents.send("chat-event", msg);
      }

      // If stream-end, resolve the pending promise
      if (msg.event === "stream-end" && id) {
        const doneKey = `${id}-done`;
        const resolve = pending.get(doneKey);
        if (resolve) {
          pending.delete(doneKey);
          resolve(undefined);
        }
      }
    } else if (id) {
      // Request-response — resolve the pending promise
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(msg.result ?? msg);
        // Reset retry counter on successful response
        spawnRetries = 0;
        backendReady = true;
      }
    }
  });

  backend.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[brainstorm] ${text}`);
    if (text.includes("ready")) backendReady = true;
  });

  backend.on("exit", (code) => {
    console.log(`Backend exited with code ${code}`);
    backend = null;
    backendReady = false;

    // Reject all pending promises immediately (don't wait for 30s timeout)
    for (const [id, resolve] of pending.entries()) {
      resolve({ error: "Backend process exited" });
    }
    pending.clear();

    // Notify all windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("chat-event", {
        type: "error",
        error: "Backend process exited",
      });
      win.webContents.send("chat-event", { type: "stream-end" });
    }

    // Auto-respawn after 2s (max 3 retries)
    if (spawnRetries < 3) {
      spawnRetries++;
      console.log(`Respawning backend (attempt ${spawnRetries}/3)...`);
      setTimeout(() => spawnBackend(), 2000);
    } else {
      console.error("Backend failed to stay alive after 3 attempts");
      // Notify renderer with unrecoverable error so UI shows permanent error state
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("chat-event", {
          type: "fatal-error",
          error:
            "Backend failed to start after 3 attempts. Please restart the application.",
        });
      }
    }
  });

  console.log(`Brainstorm backend started (PID: ${backend.pid})`);
  // Don't set backendReady until first successful response or stderr "ready"
}

// ── IPC Handlers ─────────────────────────────────────────────────

// IPC method allowlist — only these methods can be called from the renderer.
// Prevents XSS from escalating to shell execution via brainstorm CLI tools.
const ALLOWED_METHODS = new Set([
  "health",
  "tools.list",
  "memory.list",
  "memory.create",
  "memory.update",
  "memory.delete",
  "skills.list",
  "models.list",
  "config.get",
  "conversations.list",
  "conversations.create",
  "conversations.fork",
  "conversations.handoff",
  "conversations.messages",
  "kairos.status",
  "kairos.start",
  "kairos.stop",
  "kairos.pause",
  "kairos.resume",
  "security.redteam",
  "workflow.presets",
  "workflow.run",
]);

function registerIPC(): void {
  // Generic request-response (with method allowlist)
  ipcMain.handle("request", async (_event, method: string, params?: any) => {
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Method not allowed: ${method}`);
    }

    const id = `req-${nextId++}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 30000);

      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      sendToBackend({ id, method, params: params ?? {} });
    });
  });

  // Chat streaming (with 5-minute timeout to prevent permanent freeze)
  ipcMain.handle("chat-stream", async (_event, params: any) => {
    const id = `stream-${nextId++}`;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(`${id}-done`);
        // Send error to renderer so UI unfreezes
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("chat-event", {
            type: "error",
            error: "Chat stream timed out after 5 minutes",
          });
          win.webContents.send("chat-event", { type: "stream-end" });
        }
        resolve();
      }, 300000); // 5 minutes

      pending.set(`${id}-done`, () => {
        clearTimeout(timer);
        resolve();
      });
      sendToBackend({ id, method: "chat.stream", params });
    });
  });

  // Open folder dialog
  ipcMain.handle("open-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Chat abort
  ipcMain.handle("chat-abort", async () => {
    const id = `abort-${nextId++}`;
    sendToBackend({ id, method: "chat.abort" });
  });
}

// ── Window ───────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const isDev = !app.isPackaged;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: "#11111b", // ctp-crust
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Block navigation injection — prevents LLM responses with crafted links
  // from navigating the renderer to arbitrary URLs
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.setWindowOpenHandler(() => ({ action: "deny" }));

  if (isDev) {
    win.loadURL("http://localhost:1420");
  } else {
    win.loadFile(join(__dirname, "../dist/index.html"));
  }

  return win;
}

// ── App lifecycle ────────────────────────────────────────────────

app.whenReady().then(() => {
  // ── Content Security Policy ─────────────────────────────────────
  // Prevents XSS from executing arbitrary scripts in the renderer.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'", // needed for inline styles (React, Tailwind)
            "font-src 'self' data:",
            "img-src 'self' data: https:",
            "connect-src 'self' ws://localhost:* http://localhost:*",
          ].join("; "),
        ],
      },
    });
  });

  // ── Auto-update ───────────────────────────────────────────────────
  // Checks GitHub releases for new versions. Silent download, prompts to install.
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (info) => {
      console.log(`Update available: ${info.version}`);
    });
    autoUpdater.on("update-downloaded", (info) => {
      console.log(`Update downloaded: ${info.version} — will install on quit`);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("chat-event", {
          type: "update-available",
          version: info.version,
        });
      }
    });
    autoUpdater.on("error", (err) => {
      console.log(`Auto-update error: ${err.message}`);
    });
    autoUpdater.checkForUpdates().catch(() => {});
  }

  spawnBackend();
  registerIPC();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (backend) {
    backend.stdin?.end();
    backend.kill();
    backend = null;
  }
});
