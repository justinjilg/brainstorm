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
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { detectBusinessHarness, loadBusinessHarness } from "@brainst0rm/config";
import {
  HarnessIndexStore,
  defaultIndexPath,
  type VerifyResult,
} from "@brainst0rm/harness-index";
import {
  HarnessWriter,
  materializeHarness,
  type MaterializeHarnessResult,
} from "@brainst0rm/harness-fs";
import { SAAS_PLATFORM_TEMPLATE } from "@brainst0rm/archetype-saas-platform";
import { MSP_TEMPLATE } from "@brainst0rm/archetype-msp";
import type { StarterTemplate } from "@brainst0rm/config";
import {
  CustomerAccountDriftDetector,
  ApplyIntentToRuntimeChangeSet,
} from "@brainst0rm/harness-drift";
import {
  HarnessLoopRunner,
  type LoopEvent as HarnessLoopEvent,
} from "@brainst0rm/harness-loop";
import TOML from "@iarna/toml";
import { createHash } from "node:crypto";

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
 * Flips to true when the global `brainstorm` binary isn't found on
 * PATH. All subsequent spawn attempts route through `npx brainstorm`
 * so `spawnBackend()` can give the npx child the same stdout/stderr/
 * exit wiring as the primary — previously the inline fallback
 * reassigned `backend` to an npx child but never attached the
 * readline/stderr/exit listeners, so a fresh-Mac DMG launch appeared
 * to hang with no error surfaced to the user.
 */
let useNpxFallback = false;
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

/**
 * Build the environment the headless backend is spawned with, self-resolving
 * BR credentials so the harness comes alive on every launch — not only when
 * the app happens to be started from a shell that exported them.
 *
 * The backend's vault chain (`isOpAvailable`) requires OP_SERVICE_ACCOUNT_TOKEN
 * and reads item names from BRAINSTORM_OP_VAULT (default "Dev Keys"). Our keys
 * live in "BrainstormOps", and the SA token itself lives in that same vault.
 * The Electron main process runs with the user's interactive 1Password session
 * (biometric / desktop-app integration), so it CAN fetch the token via `op`
 * even in a GUI launch, then hand it to the token-gated headless child.
 *
 * Best-effort: any failure leaves the inherited env untouched (no regression),
 * and BR simply reports disconnected until credentials are configured.
 */
function resolveBackendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Preferred path: Brainstorm's OWN encrypted vault (~/.brainstorm/vault.enc),
  // auto-unlocked from the OS keychain. When it exists, the backend resolves
  // every key natively and `op` is not required at all — so skip the 1Password
  // shell-out entirely. Run `brainstorm vault bootstrap` once to populate it.
  const nativeVault = join(homedir(), ".brainstorm", "vault.enc");
  if (existsSync(nativeVault)) {
    logToFile("Native key vault present — resolving keys via keychain, not op");
    return env;
  }

  // Fallback (no native vault yet): resolve BR creds via 1Password so a fresh
  // machine still comes alive before bootstrap.
  // Non-secret: point the vault bridge at the vault that holds the
  // canonically-named API-key items.
  if (!env.BRAINSTORM_OP_VAULT) env.BRAINSTORM_OP_VAULT = "BrainstormOps";
  // Secret: fetch the service-account token from 1Password if it isn't already
  // in the environment. Stays in the vault — never written to disk here.
  if (!env.OP_SERVICE_ACCOUNT_TOKEN) {
    try {
      const token = execFileSync(
        "op",
        [
          "item",
          "get",
          "bench-OP_SERVICE_ACCOUNT_TOKEN",
          "--vault",
          env.BRAINSTORM_OP_VAULT,
          "--fields",
          "credential",
          "--reveal",
        ],
        { timeout: 8000, stdio: ["pipe", "pipe", "pipe"] },
      )
        .toString()
        .trim();
      if (token) {
        env.OP_SERVICE_ACCOUNT_TOKEN = token;
        logToFile("Resolved OP_SERVICE_ACCOUNT_TOKEN for backend via op");
      }
    } catch (err) {
      logToFile(
        `Could not resolve OP_SERVICE_ACCOUNT_TOKEN via op (BR keys fall back to env): ${
          err instanceof Error ? err.message.split("\n")[0] : String(err)
        }`,
      );
    }
  }
  return env;
}

function spawnBackend(): void {
  // Primary: global `brainstorm` binary. Fallback: `npx brainstorm` —
  // gated by the useNpxFallback module flag so the rest of this
  // function (rl/stderr/exit wiring) is applied uniformly to whichever
  // child we end up with.
  const isWindows = process.platform === "win32";
  const cmd = useNpxFallback
    ? isWindows
      ? "npx.cmd"
      : "npx"
    : isWindows
      ? "brainstorm.cmd"
      : "brainstorm";
  const args = useNpxFallback ? ["brainstorm", "ipc"] : ["ipc"];

  try {
    backend = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: resolveBackendEnv(),
    });
  } catch (err) {
    // spawn() can throw synchronously if the cmd is utterly missing in
    // some environments; handle that alongside the async 'error' path.
    notifyCliMissing(err instanceof Error ? err.message : String(err));
    return;
  }

  // Async ENOENT path. On failure of the primary, flip the npx flag
  // and recursively call spawnBackend() — that way the fallback child
  // gets the full rl/stderr/exit setup below, NOT the dead primary.
  // Previously the fallback ran inline and left the npx child with no
  // stdio wiring, so the app silently hung on fresh-Mac launches with
  // no `brainstorm` on PATH. If the fallback ALSO ENOENTs (no npx
  // either), bubble up via notifyCliMissing — can't recover further.
  backend.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" && !useNpxFallback) {
      logToFile(`brainstorm CLI not on PATH — retrying via npx`);
      useNpxFallback = true;
      spawnBackend();
      return;
    }
    notifyCliMissing(
      err.code === "ENOENT"
        ? useNpxFallback
          ? "neither brainstorm nor npx is on PATH"
          : "brainstorm not on PATH"
        : err.message,
    );
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

  // ── Business harness IPC ──────────────────────────────────────
  // Per the spec at ~/.claude/plans/snuggly-sleeping-hinton.md, the
  // desktop's primary navigation root is the harness — a folder
  // containing business.toml. These three routes detect, parse, and
  // open harnesses; the renderer composes them into the harness picker.

  /**
   * Detect a harness by walking up from a given path looking for
   * business.toml. Returns:
   *   { kind: "business", root, manifest }  — found and valid
   *   { kind: "code", root: path }          — no business.toml found
   *   { kind: "error", root, error, message } — found but invalid
   */
  ipcMain.handle("harness.detect", async (_event, path: string) => {
    const detectResult = detectBusinessHarness(path);
    if (!detectResult) {
      // No harness anywhere upward; treat as a code-project root
      return { kind: "code", root: path };
    }
    if (detectResult.ok === true) {
      return {
        kind: "business",
        root: detectResult.root,
        manifest: detectResult.manifest,
      };
    } else {
      return {
        kind: "error",
        root: detectResult.root,
        manifestPath: detectResult.manifestPath,
        error: detectResult.error,
        message: detectResult.message,
      };
    }
  });

  /**
   * Open native folder picker, then run detect on the selected folder.
   * One round trip from the renderer's "Open" button.
   */
  ipcMain.handle("harness.openDialog", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Open Business Harness or Code Project",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { kind: "cancel" };
    }
    const path = result.filePaths[0]!;
    // Reuse the detect logic — opening a folder that turns out to be a
    // regular code project just becomes the existing code-project flow.
    const detectResult = detectBusinessHarness(path);
    if (!detectResult) {
      return { kind: "code", root: path };
    }
    if (detectResult.ok === true) {
      return {
        kind: "business",
        root: detectResult.root,
        manifest: detectResult.manifest,
      };
    } else {
      return {
        kind: "error",
        root: detectResult.root,
        manifestPath: detectResult.manifestPath,
        error: detectResult.error,
        message: detectResult.message,
      };
    }
  });

  // ── Index lifecycle ───────────────────────────────────────────
  // Per spec ## Index Coherence, the harness opens with a cold-open
  // verification pass. The index store stays open for the session so
  // subsequent writes go through write-through cleanly.

  type ActiveHarnessSession = {
    root: string;
    harnessId: string;
    index: HarnessIndexStore;
    writer: HarnessWriter;
    loop: HarnessLoopRunner;
  };
  let activeSession: ActiveHarnessSession | null = null;
  /**
   * Persist + broadcast a loop event. Persistence goes through the active
   * session's harness-index `loop_events` table so history survives a
   * desktop restart; the in-memory ring buffer the previous version kept
   * is gone now that the DB is the source of truth. `onEvent` only fires
   * after `harness.openSession` succeeds, so `activeSession` is always
   * set when this runs — but we guard defensively in case that invariant
   * ever loosens.
   */
  function recordLoopEvent(event: HarnessLoopEvent): void {
    if (activeSession) {
      try {
        activeSession.index.recordLoopEvent(event);
      } catch (e) {
        // Persistence is best-effort. If the DB write fails (e.g. mid-
        // close race), we still broadcast so live UI updates aren't lost.
        console.warn("loop event persistence failed:", e);
      }
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("harness.loop-event", event);
    }
  }

  function harnessIdFromRoot(root: string): string {
    // Stable id per-harness-root: SHA-256 of the absolute path. This is
    // deterministic and machine-local — two clones on the same laptop
    // share an index id; but per Decision #11, indexes are per-user so
    // this is correct.
    return createHash("sha256").update(root).digest("hex").slice(0, 16);
  }

  function closeActiveSession(): void {
    if (activeSession) {
      activeSession.loop.stop();
      activeSession.index.close();
      activeSession = null;
    }
  }

  ipcMain.handle(
    "harness.openSession",
    async (
      _event,
      root: string,
    ): Promise<
      | {
          ok: true;
          harnessId: string;
          verify: VerifyResult;
        }
      | { ok: false; error: string }
    > => {
      try {
        closeActiveSession();
        const harnessId = harnessIdFromRoot(root);
        const index = new HarnessIndexStore(defaultIndexPath(harnessId));
        const writer = new HarnessWriter(root);

        // Always compact the WAL on cold-open. compactWal() rewrites the
        // log to contain only unfinalized entries, so calling it
        // unconditionally prevents the WAL from growing unboundedly with
        // finalized (committed/aborted) entries across successful sessions.
        // Pending entries (if any) survive the compact and are recoverable
        // by the next session; coldOpenVerify() below re-detects any drift
        // they would have caused. Actual replay that re-issues index
        // updates requires the full parser pipeline — v1.5+.
        writer.compactWal();

        // Cold-open verify per spec performance budget
        const verify = index.coldOpenVerify(root);

        const loop = new HarnessLoopRunner({
          harnessRoot: root,
          index,
          onEvent: (event) => recordLoopEvent(event),
        });
        activeSession = { root, harnessId, index, writer, loop };
        // Start scheduled loops only after the session is fully wired so
        // events have a destination to flow to.
        loop.start();
        return { ok: true, harnessId, verify };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  ipcMain.handle("harness.closeSession", async () => {
    closeActiveSession();
    return { ok: true };
  });

  /**
   * Scaffold a new business harness on disk. Wraps `materializeHarness`
   * from @brainst0rm/harness-fs (the same function the CLI uses for
   * `brainstorm harness init`). The renderer's NewHarnessWizard calls
   * this; on success the renderer follows up with `harness.openSession`
   * to load the new harness into a session.
   *
   * Templates are resolved here because @brainst0rm/harness-fs deliberately
   * doesn't depend on archetype packages (those bundle large starter
   * content that would bloat every harness-fs consumer).
   */
  ipcMain.handle(
    "harness.init",
    async (
      _event,
      params: {
        name: string;
        archetype: string;
        parentRoot: string;
        templateSlug?: string;
      },
    ): Promise<MaterializeHarnessResult> => {
      const template = resolveTemplate(params.templateSlug);
      if (params.templateSlug && !template) {
        return {
          ok: false,
          error: `unknown template '${params.templateSlug}' — desktop knows only 'saas-platform' and 'msp'`,
        };
      }
      return materializeHarness({
        name: params.name,
        archetype: params.archetype,
        parentRoot: params.parentRoot,
        template,
      });
    },
  );

  /**
   * Cleanup on app quit: close any active index connection cleanly so
   * SQLite WAL mode doesn't leak journals.
   */
  app.on("before-quit", () => {
    closeActiveSession();
  });

  /**
   * Re-parse a harness's business.toml without walking. Used by the
   * renderer to refresh manifest data after the file changes on disk.
   */
  ipcMain.handle("harness.parse", async (_event, root: string) => {
    const result = loadBusinessHarness(root);
    if (result.ok === true) {
      return {
        kind: "business",
        root: result.root,
        manifest: result.manifest,
      };
    } else {
      return {
        kind: "error",
        root: result.root,
        manifestPath: result.manifestPath,
        error: result.error,
        message: result.message,
      };
    }
  });

  /**
   * List artifacts in the active harness whose relative_path starts with
   * the given folder slug. Used by BusinessHarnessView's per-folder panels.
   */
  ipcMain.handle(
    "harness.listFolder",
    async (
      _event,
      folderSlug: string,
    ): Promise<{
      folder: string;
      artifacts: Array<{
        relative_path: string;
        artifact_kind: string;
        owner: string | null;
        status: string | null;
        reviewed_at: number | null;
        size_bytes: number;
        mtime_ms: number;
      }>;
    }> => {
      if (!activeSession) {
        return { folder: folderSlug, artifacts: [] };
      }
      const all = activeSession.index.allArtifacts();
      const prefix = folderSlug.endsWith("/") ? folderSlug : `${folderSlug}/`;
      const matched = all
        .filter((a) => a.relative_path.startsWith(prefix))
        .map((a) => ({
          relative_path: a.relative_path,
          artifact_kind: a.artifact_kind,
          owner: a.owner,
          status: a.status,
          reviewed_at: a.reviewed_at,
          size_bytes: a.size_bytes,
          mtime_ms: a.mtime_ms,
        }));
      return { folder: folderSlug, artifacts: matched };
    },
  );

  /**
   * Run the customer-account intent ↔ runtime drift detector against
   * the active harness session. Returns drifts + accounts that have no
   * runtime.toml observation file (= "wire a poller" hint).
   */
  ipcMain.handle(
    "harness.detectCustomerDrift",
    async (): Promise<{
      drifts: Array<{
        id: string;
        relative_path: string;
        field_path: string;
        intent_value: string | null;
        observed_value: string | null;
        severity: string;
      }>;
      unobserved_accounts: string[];
    }> => {
      if (!activeSession) {
        return { drifts: [], unobserved_accounts: [] };
      }
      const detector = new CustomerAccountDriftDetector(activeSession.root);
      const drifts = await detector.detect();
      const unobserved = detector.unobservedAccounts();
      return {
        drifts: drifts.map((d) => ({
          id: d.id,
          relative_path: d.relative_path,
          field_path: d.field_path,
          intent_value: d.intent_value,
          observed_value: d.observed_value,
          severity: d.severity,
        })),
        unobserved_accounts: unobserved,
      };
    },
  );

  /**
   * Apply a customer-account intent → runtime ChangeSet. Reads the open
   * drift from drift_state, constructs ApplyIntentToRuntimeChangeSet
   * whose apply callback writes the intent value into the matching
   * runtime.toml `*_observed` field (the v1 stub-runtime — replaced when
   * a real Stripe/MSP poller is wired). On success, marks the drift
   * resolved and re-runs the detector so the UI refreshes.
   */
  ipcMain.handle(
    "harness.applyCustomerDrift",
    async (
      _event,
      driftId: string,
    ): Promise<
      { ok: true; description: string } | { ok: false; error: string }
    > => {
      if (!activeSession) {
        return { ok: false, error: "no active harness session" };
      }
      const open = activeSession.index.unresolvedDrift();
      const drift = open.find((d) => d.id === driftId);
      if (!drift) {
        return {
          ok: false,
          error: `drift not found or already resolved: ${driftId}`,
        };
      }
      // Locate the matching runtime.toml — `relative_path` looks like
      // "customers/accounts/{slug}/account.toml".
      const accountDir = join(activeSession.root, dirname(drift.relative_path));
      const runtimePath = join(accountDir, "runtime.toml");
      const observedField = mapIntentFieldToObserved(drift.field_path);
      if (!observedField) {
        return {
          ok: false,
          error: `no runtime mapping for intent field ${drift.field_path}`,
        };
      }
      try {
        const changeset = new ApplyIntentToRuntimeChangeSet({
          drift: {
            ...drift,
            field_class: "intent",
            detected_at: Date.now(),
            severity: (drift.severity ?? "medium") as
              | "informational"
              | "low"
              | "medium"
              | "high"
              | "critical"
              | "incident-required",
          },
          actor_ref: "team/humans/desktop-user",
          intent_value: drift.intent_value,
          apply: (value) => {
            // v1 stub-runtime: persist the intent value as the new observed
            // value in runtime.toml. When a real runtime poller is wired,
            // this callback is replaced with an API call (Stripe.subscriptionUpdate
            // etc.) and runtime.toml becomes the polled cache it already is.
            const existing = existsSync(runtimePath)
              ? (TOML.parse(readFileSync(runtimePath, "utf-8")) as Record<
                  string,
                  unknown
                >)
              : {};
            const numericValue = parseValueForToml(value);
            existing[observedField] = numericValue;
            writeFileSync(
              runtimePath,
              TOML.stringify(existing as TOML.JsonMap),
              "utf-8",
            );
          },
        });
        const result = await changeset.apply();
        if (!result.ok) {
          return { ok: false, error: result.message ?? "apply failed" };
        }
        activeSession.index.resolveDrift(driftId);
        return {
          ok: true,
          description: changeset.simulate().description,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  /**
   * Return the most recent N loop events (default 50). Used by the
   * desktop's harness session header to populate the live event log on
   * mount, before subscribing to harness.loop-event. Reads from the
   * active session's harness-index `loop_events` table so history
   * survives desktop restarts.
   */
  ipcMain.handle(
    "harness.recentLoopEvents",
    async (_event, limit?: number): Promise<HarnessLoopEvent[]> => {
      if (!activeSession) return [];
      const n = typeof limit === "number" && limit > 0 ? limit : 50;
      // Store returns newest-first; the renderer expects oldest-first
      // (events are appended bottom-of-list as they arrive). Reverse here.
      const rows = activeSession.index.recentLoopEvents({ limit: n });
      return rows.reverse().map((row) => ({
        loop: row.loop as HarnessLoopEvent["loop"],
        status: row.status as HarnessLoopEvent["status"],
        at: row.at,
        summary: row.summary,
        error: row.error,
      }));
    },
  );

  /**
   * Trigger one immediate run of a named loop in the active session.
   * Returns the resulting LoopEvent (which is also broadcast).
   */
  ipcMain.handle(
    "harness.runLoopOnce",
    async (
      _event,
      loopName: "indexer" | "customer-drift" | "stale-watchdog",
    ): Promise<HarnessLoopEvent | { ok: false; error: string }> => {
      if (!activeSession) {
        return { ok: false, error: "no active harness session" };
      }
      try {
        return await activeSession.loop.runOnce(loopName);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

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
    // DevTools no longer auto-opens — the app should launch as a clean product
    // surface, not a debugger. Opt in with BRAINSTORM_DEVTOOLS=1, or open it
    // any time from the View menu / ⌥⌘I.
    if (process.env.BRAINSTORM_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
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
  // Quit on last-window-close on every platform — this is a
  // single-window app with no menu-bar value-add, so leaving the
  // process alive on macOS just keeps the harness loops (indexer,
  // customer-drift, stale-watchdog) running against a closed UI,
  // which is how the v1 build leaked memory in long sessions.
  app.quit();
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
  //
  // Use `exitCode === null && signalCode === null` to detect "still
  // running" rather than `child.killed`. `child.killed` is set the
  // moment `.kill()` returns from the syscall, regardless of whether
  // the OS process has actually terminated — so the prior
  // `if (!child.killed)` gate ALWAYS tested false after the SIGTERM
  // above, and SIGKILL never actually fired. Result: the "slow DB
  // flush leaves orphan" scenario the comment describes silently
  // failed through. Now checks the process-liveness properties that
  // Node actually updates when the child exits.
  const killer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* raced with the child's own exit */
      }
    }
  }, 1_500);
  killer.unref?.();
});

/**
 * Map a customer-account intent field name (in account.toml) to its
 * paired observed-value field name in runtime.toml. Mirrors the
 * FIELD_PAIRS table in CustomerAccountDriftDetector — kept in sync
 * here because the detector doesn't expose it publicly.
 */
function mapIntentFieldToObserved(intentField: string): string | null {
  const pairs: Record<string, string> = {
    mrr_intent: "mrr_observed",
    status: "status_observed",
    tier: "tier_observed",
  };
  return pairs[intentField] ?? null;
}

/**
 * Coerce the drift's serialized intent value back into the type
 * runtime.toml expects (numbers stay numbers; strings stay strings).
 * The CustomerAccountDriftDetector serializes via `JSON.stringify` for
 * non-strings; we reverse that here.
 */
function parseValueForToml(
  value: string | null,
): string | number | boolean | null {
  if (value === null) return null;
  // Quoted JSON strings come through as `"foo"`; unwrap.
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  if (!Number.isNaN(n) && value.trim() !== "") return n;
  return value;
}

/**
 * Look up a starter template by slug. Mirrors the CLI's
 * `harness-templates.ts` registry but kept narrow here so the desktop
 * doesn't depend on the CLI package.
 */
function resolveTemplate(
  slug: string | undefined,
): StarterTemplate | undefined {
  if (!slug) return undefined;
  switch (slug) {
    case "saas-platform":
      return SAAS_PLATFORM_TEMPLATE;
    case "msp":
      return MSP_TEMPLATE;
    default:
      return undefined;
  }
}
