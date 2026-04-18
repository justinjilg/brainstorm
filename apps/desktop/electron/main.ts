/**
 * Electron Main Process — spawns brainstorm ipc as a child process.
 *
 * Uses the same NDJSON stdio protocol we built for Tauri, but now
 * Electron's main process manages the child instead of Rust.
 * This avoids native module rebuild issues (better-sqlite3 runs
 * in the child's regular Node.js, not Electron's modified V8).
 */

import { app, BrowserWindow, ipcMain, dialog, session } from "electron";
// electron-updater is shipped as CommonJS. apps/desktop is ESM
// ("type": "module"), so a named import fails with "Named export
// 'autoUpdater' not found" at Electron startup. Default-import the
// module and destructure — this is the documented interop pattern.
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Structured logging ──────────────────────────────────────────────

const LOG_DIR = join(
  process.platform === "darwin"
    ? join(homedir(), "Library", "Logs", "Brainstorm")
    : join(homedir(), ".brainstorm", "logs"),
);

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // Log dir creation failed — fall back to console only
}

function logToFile(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${msg}\n`;
  console.log(msg);
  try {
    appendFileSync(join(LOG_DIR, "brainstorm-desktop.log"), line);
  } catch {
    // File write failed — console only
  }
}

// ── Backend process management ───────────────────────────────────

let backend: ChildProcess | null = null;
let backendReady = false;
let spawnRetries = 0;
/**
 * Per-request pending handlers. Stored as {settle, reject} so that
 * backend-exit can reject the promise cleanly, rather than resolving
 * with an `{error:"..."}` sentinel that every caller would have to
 * null-check. Previously this was a single-callback map and backend
 * crashes "resolved" every in-flight request with a fake success value,
 * which data hooks treated as legitimate data.
 */
interface PendingEntry {
  settle: (value: any) => void;
  reject: (err: Error) => void;
}
const pending = new Map<string, PendingEntry>();
// Per-request timers — cleared on backend exit so a timer that was scheduled
// for a request in flight doesn't fire after the backend has already
// respawned, sending a stale "timed out" event to the UI minutes later.
const pendingTimers = new Map<string, NodeJS.Timeout>();
let nextId = 1;

// Messages queued while the backend is down. Flushed in order once the
// next child spawns and emits {type:"ready"}. Without this queue, any
// IPC call that fires during the ~2s respawn window is silently
// dropped — which is exactly what broke crash-recovery in
// tests-live/backend-crash.live.spec.ts before this fix.
const pendingOutbound: Array<Record<string, unknown>> = [];
const MAX_PENDING_OUTBOUND = 50;

function sendToBackend(msg: Record<string, unknown>): void {
  if (backend?.stdin?.writable && backendReady) {
    backend.stdin.write(JSON.stringify(msg) + "\n");
    return;
  }
  // Queue up while we're mid-respawn. Cap at 50 to avoid runaway
  // memory if the backend is permanently dead — beyond that we'd
  // rather drop new messages than leak.
  if (pendingOutbound.length >= MAX_PENDING_OUTBOUND) {
    logToFile(
      `sendToBackend: dropping ${String(msg.method ?? msg.event ?? "?")} — queue full`,
    );
    return;
  }
  pendingOutbound.push(msg);
  logToFile(
    `sendToBackend: queued ${String(msg.method ?? msg.event ?? "?")} (backend down, queue=${pendingOutbound.length})`,
  );
}

function flushPendingOutbound(): void {
  if (!backend?.stdin?.writable) return;
  while (pendingOutbound.length > 0) {
    const msg = pendingOutbound.shift()!;
    backend.stdin.write(JSON.stringify(msg) + "\n");
  }
}

/**
 * Surface a fatal spawn failure to every renderer window. Used when the
 * brainstorm CLI cannot be found (ENOENT) or the child exits before any
 * stdio can be attached — e.g., a fresh-Mac DMG launch where the user
 * never ran `npm install -g @brainst0rm/cli`. Renderer renders a
 * prominent banner with install instructions.
 */
function notifyCliMissing(detail: string): void {
  logToFile(`CLI locator: ${detail}`);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("chat-event", {
      type: "fatal-error",
      error: `Brainstorm CLI not found on PATH. Install with: npm install -g @brainst0rm/cli  —  then relaunch the app.\n(detail: ${detail})`,
    });
  }
}

function spawnBackend(): void {
  // Find brainstorm CLI — try global install first, then npx
  const cmd = process.platform === "win32" ? "brainstorm.cmd" : "brainstorm";

  try {
    backend = spawn(cmd, ["ipc"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (err) {
    // spawn() can throw synchronously if the cmd is utterly missing in
    // some environments; handle that alongside the async 'error' path.
    notifyCliMissing(err instanceof Error ? err.message : String(err));
    return;
  }

  // If the primary spawn emits ENOENT asynchronously, fall through to an
  // npx retry. The retry is best-effort — a packaged DMG on a brand-new
  // Mac may not have npm installed at all.
  backend.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      logToFile(`brainstorm CLI not on PATH — trying npx fallback`);
      try {
        backend = spawn("npx", ["brainstorm", "ipc"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
        backend.once("error", (npxErr: NodeJS.ErrnoException) => {
          notifyCliMissing(
            npxErr.code === "ENOENT"
              ? "neither brainstorm nor npx is on PATH"
              : npxErr.message,
          );
        });
      } catch (npxErr) {
        notifyCliMissing(
          npxErr instanceof Error ? npxErr.message : String(npxErr),
        );
      }
    } else {
      notifyCliMissing(err.message);
    }
  });

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

    // Structured readiness signal from the backend. This is the authoritative
    // source — it's emitted exactly once at startup. The previous approach of
    // substring-matching stderr for "ready" would flip backendReady on any
    // log line containing that word (e.g. "database not ready",
    // "already running"), causing the renderer to send requests to a
    // not-actually-ready backend.
    if (msg.type === "ready") {
      const wasReady = backendReady;
      backendReady = true;
      spawnRetries = 0;
      logToFile("Backend emitted ready signal");
      // Drain any IPC calls that arrived during the respawn gap before
      // we tell the renderer about the new backend. Doing it in this
      // order means the renderer's first post-recovery request isn't
      // racing any queued message this new child hasn't seen yet.
      flushPendingOutbound();
      // Forward ready signal to the renderer so hooks that loaded once at
      // mount can refetch after a crash+respawn. We include wasReady so
      // clients can distinguish the first ready (no refetch needed — the
      // hook's initial load handles it) from a recovery ready (refetch).
      const wins = BrowserWindow.getAllWindows();
      if (wins.length === 0) {
        // Backend beat the renderer — no window to notify yet.
        // createWindow() below picks up the sticky flag and re-fires.
        logToFile("Ready beat window creation; deferring");
      }
      for (const win of wins) {
        win.webContents.send("backend-ready", { recovery: wasReady });
      }
      return;
    }

    if (msg.event) {
      // Streaming event — forward to all renderer windows
      if (msg.event === "text-delta") {
        // One-line summary so we can see tokens are actually arriving
        // without dumping every delta.
        const delta = (msg.data as any)?.delta ?? "";
        logToFile(`backend event: text-delta (${delta.length} chars)`);
      } else {
        logToFile(
          `backend event: ${msg.event}${msg.data?.error ? ` error="${msg.data.error}"` : ""}`,
        );
      }
      const wins = BrowserWindow.getAllWindows();
      for (const win of wins) {
        win.webContents.send("chat-event", msg);
      }

      // If stream-end, resolve the pending promise
      if (msg.event === "stream-end" && id) {
        const doneKey = `${id}-done`;
        const entry = pending.get(doneKey);
        if (entry) {
          pending.delete(doneKey);
          entry.settle(undefined);
        }
      }
    } else if (id) {
      // Request-response — resolve the pending promise
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.settle(msg.result ?? msg);
        // Reset retry counter on successful response
        spawnRetries = 0;
        backendReady = true;
      }
    }
  });

  backend.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) logToFile(`[brainstorm] ${text}`);
    // Readiness is now signaled via structured JSON on stdout (msg.type
    // === "ready"). stderr is just for logs; never infer state from it.
  });

  backend.on("exit", (code) => {
    logToFile(`Backend exited with code ${code}`);
    backend = null;
    backendReady = false;

    // Reject all pending promises immediately (don't wait for 30s timeout).
    // Using reject rather than resolve({error}) so data hooks' .catch()
    // blocks actually fire — the old code silently handed every caller
    // a fake success value containing {error:"..."} that callers would
    // render as legitimate data.
    const backendExit = new Error("Backend process exited");
    for (const [, entry] of pending.entries()) {
      entry.reject(backendExit);
    }
    pending.clear();

    // Clear any per-request timers — otherwise a chat-stream timer scheduled
    // before the exit will later fire (minutes later, after respawn) and
    // send a misleading "timed out" event to the UI.
    for (const timer of pendingTimers.values()) {
      clearTimeout(timer);
    }
    pendingTimers.clear();

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
      logToFile(`Respawning backend (attempt ${spawnRetries}/3)...`);
      setTimeout(() => spawnBackend(), 2000);
    } else {
      logToFile("Backend failed to stay alive after 3 attempts");
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

  logToFile(`Brainstorm backend started (PID: ${backend.pid})`);
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
  // chat.abort signals the backend to stop an in-flight stream. Without
  // this entry the allowlist rejected the call and the catch {} in
  // ipc-client.ts swallowed the rejection — the Abort button in the UI
  // flipped local state while the backend kept generating (and billing)
  // until the 5-min main-process timeout fired. See docs/desktop-audit.md H1.
  "chat.abort",
  // cost.summary aggregates cost_records by day/month/model. Without
  // this entry the Dashboard Cost tab fell back to the session-only
  // number and hardcoded $0.0000 for today/month (see docs/desktop-audit.md F4).
  "cost.summary",
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
        pendingTimers.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 30000);
      pendingTimers.set(id, timer);

      pending.set(id, {
        settle: (result) => {
          clearTimeout(timer);
          pendingTimers.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          pendingTimers.delete(id);
          reject(err);
        },
      });

      sendToBackend({ id, method, params: params ?? {} });
    });
  });

  // Chat streaming (with 5-minute timeout to prevent permanent freeze)
  ipcMain.handle("chat-stream", async (_event, params: any) => {
    const id = `stream-${nextId++}`;
    const doneKey = `${id}-done`;
    logToFile(
      `chat-stream received (id=${id}, model=${params?.modelId ?? "auto"}, conv=${params?.conversationId ?? "new"}, msg=${String(params?.message ?? "").slice(0, 60)}…)`,
    );

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(doneKey);
        pendingTimers.delete(doneKey);
        // Tell the backend to abort the stream before we resolve our
        // promise. Pre-fix we just unfroze the UI here — the backend
        // kept generating (and billing) until the turn finished naturally,
        // and any tool results emitted afterwards leaked into the NEXT
        // user message since nothing cleared the handler's abortController.
        const abortReqId = `abort-after-timeout-${nextId++}`;
        sendToBackend({
          id: abortReqId,
          method: "chat.abort",
          params: {},
        });
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
      pendingTimers.set(doneKey, timer);

      pending.set(doneKey, {
        settle: () => {
          clearTimeout(timer);
          pendingTimers.delete(doneKey);
          resolve();
        },
        // A backend exit mid-stream already fires a stream-end + error
        // event from the exit handler above (see "Notify all windows").
        // We resolve() here rather than reject so the renderer's
        // `await chatStream()` unblocks and re-enters the idle state
        // — the surfaced error is the source of truth for the user.
        reject: () => {
          clearTimeout(timer);
          pendingTimers.delete(doneKey);
          resolve();
        },
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

  // Backend-ready sticky state — let the renderer resolve the race where
  // main emits "backend-ready" before React attaches the onBackendReady
  // listener. useBackendReady calls this on mount and flips to true
  // immediately if the main-side sticky flag is already set.
  ipcMain.handle("main.backend-ready-state", () => backendReady);
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
    backgroundColor: "#111215", // ink-1 (BR palette) — mirrors the renderer pre-paint
    // Do not auto-open DevTools in production. Dev workflows can still
    // toggle via View → Toggle Developer Tools or ⌥⌘I; a packaged
    // build never opens the inspector on its own.
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Block navigation injection — prevents LLM responses with crafted links
  // from navigating the renderer to arbitrary URLs
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // setWindowOpenHandler lives on webContents in Electron 12+, not on
  // BrowserWindow directly. The older BrowserWindow.setWindowOpenHandler
  // alias was removed somewhere around Electron 30 — on 41 it throws
  // "setWindowOpenHandler is not a function" at createWindow time.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Belt-and-braces: if the backend emitted its ready signal BEFORE this
  // window existed, BrowserWindow.getAllWindows() was empty and the
  // forwarded event was dropped. Re-send once the page finishes loading
  // so the renderer's useBackendReady hook flips even in the race.
  win.webContents.once("did-finish-load", () => {
    if (backendReady) {
      logToFile("Re-fired backend-ready on did-finish-load (was sticky)");
      win.webContents.send("backend-ready", { recovery: false });
    }
  });

  if (isDev) {
    win.loadURL("http://localhost:1420");
    // Open DevTools in dev so renderer errors are immediately visible.
    // Packaged builds stay gated behind the View menu / ⌥⌘I.
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "../dist/index.html"));
  }

  // Surface renderer failures to the main log — critical when the
  // window paints white and the only evidence is a silent crash.
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logToFile(`Renderer did-fail-load: code=${code} desc="${desc}" url=${url}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    logToFile(`Renderer render-process-gone: reason=${details.reason}`);
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    logToFile(`Preload error at ${preloadPath}: ${error.message}`);
  });
  win.webContents.on(
    "console-message",
    (_e, level, message, line, sourceId) => {
      if (level >= 2) {
        logToFile(`Renderer[${level}] ${sourceId}:${line} ${message}`);
      }
    },
  );

  return win;
}

// ── App lifecycle ────────────────────────────────────────────────

app.whenReady().then(() => {
  // ── Content Security Policy ─────────────────────────────────────
  // Prevents XSS from executing arbitrary scripts in the renderer.
  //
  // Dev mode (loadURL → http://localhost:1420): Vite injects an inline
  // <script> preamble for @vitejs/plugin-react HMR. Blocking it makes
  // the renderer paint black and log "can't detect preamble" — so dev
  // gets 'unsafe-inline' for scripts.
  //
  // Packaged builds get the tight script-src 'self' — all JS is bundled
  // and served from the file:// app root, no inline scripts exist.
  const isDev = !app.isPackaged;
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self'";
  const connectSrc = isDev
    ? "connect-src 'self' ws://localhost:* http://localhost:*"
    : "connect-src 'self'";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self'",
            scriptSrc,
            "style-src 'self' 'unsafe-inline'", // needed for inline styles (React, Tailwind)
            "font-src 'self' data:",
            "img-src 'self' data: https:",
            connectSrc,
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
      logToFile(`Update available: ${info.version}`);
    });
    autoUpdater.on("update-downloaded", (info) => {
      logToFile(`Update downloaded: ${info.version} — will install on quit`);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("chat-event", {
          type: "update-available",
          version: info.version,
        });
      }
    });
    autoUpdater.on("error", (err) => {
      logToFile(`Auto-update error: ${err.message}`);
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
  if (!backend) return;
  // Ordered tear-down: close stdin so the child sees EOF, send a
  // SIGTERM to let it flush open DB transactions, then — if the child
  // hasn't exited inside a short grace window — force-kill with
  // SIGKILL. Without the SIGKILL fallback a slow DB flush (Argon2id
  // vault close, WAL checkpoint, etc.) could leave an orphan process
  // running after Electron has already closed its window. The live-
  // harness teardown test (tests-live/teardown.live.spec.ts) catches
  // exactly this shape — before the fallback landed, the orphan
  // assertion fired intermittently under suite load.
  const child = backend;
  backend = null;
  try {
    child.stdin?.end();
  } catch {
    /* stdin may already be closed — harmless */
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead — harmless */
  }
  // Use an unref'd timer so the kill watchdog doesn't block Electron's
  // own exit. If the child is still around after 1.5s, blast it. The
  // main process is on its way out anyway — we don't wait for confirmation.
  const killer = setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* raced with the child's own exit */
      }
    }
  }, 1_500);
  killer.unref?.();
});
