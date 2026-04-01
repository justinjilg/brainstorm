/**
 * Dream Cycle Runner — memory consolidation on a schedule.
 *
 * Runs the dream consolidation cycle by spawning an explore subagent
 * to review, deduplicate, and consolidate memory files. Gated by time,
 * session count, and a lockfile to prevent concurrent runs.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "@brainst0rm/shared";
import { DREAM_SYSTEM_PROMPT, buildDreamPrompt } from "./dream.js";
import { spawnSubagent, type SubagentOptions } from "../agent/subagent.js";

const log = createLogger("dream-runner");

// ── Constants ──────────────────────────────────────────────────────

const DREAM_STATE_FILE = ".dream-state.json";
const DREAM_LOCK_FILE = ".dream-lock";
const MIN_HOURS_BETWEEN_DREAMS = 24;
const MIN_SESSIONS_BETWEEN_DREAMS = 5;
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
const DREAM_BUDGET = 0.05; // $0.05 max per cycle

// ── Types ──────────────────────────────────────────────────────────

interface DreamState {
  lastDreamAt: number; // epoch ms
  sessionsSinceDream: number;
}

interface DreamGateResult {
  due: boolean;
  reason: string;
}

interface DreamCycleOptions {
  /** Path to the memory directory */
  memoryDir: string;
  /** Override session count (for testing) */
  sessionCount?: number;
  /** Skip gate checks (force run) */
  force?: boolean;
  /** Subagent options — needed to spawn the dream subagent */
  subagentOptions: Omit<
    SubagentOptions,
    "type" | "systemPrompt" | "budgetLimit" | "maxSteps"
  >;
}

export interface DreamCycleResult {
  ran: boolean;
  summary: string;
  cost: number;
  filesProcessed: number;
}

// ── State Management ───────────────────────────────────────────────

function getStatePath(memoryDir: string): string {
  return join(memoryDir, DREAM_STATE_FILE);
}

function getLockPath(memoryDir: string): string {
  return join(memoryDir, DREAM_LOCK_FILE);
}

function readDreamState(memoryDir: string): DreamState {
  const statePath = getStatePath(memoryDir);
  if (!existsSync(statePath)) {
    return { lastDreamAt: 0, sessionsSinceDream: 0 };
  }
  try {
    const raw = readFileSync(statePath, "utf-8");
    return JSON.parse(raw) as DreamState;
  } catch {
    log.warn({ path: statePath }, "Corrupt dream state file, resetting");
    return { lastDreamAt: 0, sessionsSinceDream: 0 };
  }
}

function writeDreamState(memoryDir: string, state: DreamState): void {
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    getStatePath(memoryDir),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

// ── Lock Management ────────────────────────────────────────────────

function acquireLock(memoryDir: string): boolean {
  const lockPath = getLockPath(memoryDir);

  if (existsSync(lockPath)) {
    // Check if lock is stale
    try {
      const stat = statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < LOCK_STALE_MS) {
        const lockContent = readFileSync(lockPath, "utf-8");
        log.info({ lockContent, ageMs }, "Dream lock held by another process");
        return false;
      }
      log.warn({ ageMs }, "Stale dream lock found, overriding");
    } catch {
      // stat failed — lock file may have been removed, proceed
    }
  }

  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      "utf-8",
    );
    return true;
  } catch (err) {
    log.error({ err }, "Failed to acquire dream lock");
    return false;
  }
}

function releaseLock(memoryDir: string): void {
  const lockPath = getLockPath(memoryDir);
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch (err) {
    log.warn({ err }, "Failed to release dream lock");
  }
}

// ── Gate Check ─────────────────────────────────────────────────────

/**
 * Check whether a dream cycle is due.
 *
 * Returns `{ due: true }` only when ALL conditions are met:
 * - 24+ hours since last dream
 * - 5+ sessions since last dream
 * - No active lock
 */
export function isDreamDue(memoryDir: string): DreamGateResult {
  const state = readDreamState(memoryDir);

  const hoursSinceLastDream =
    state.lastDreamAt > 0
      ? (Date.now() - state.lastDreamAt) / (1000 * 60 * 60)
      : Infinity;

  if (hoursSinceLastDream < MIN_HOURS_BETWEEN_DREAMS) {
    return {
      due: false,
      reason: `Only ${hoursSinceLastDream.toFixed(1)}h since last dream (need ${MIN_HOURS_BETWEEN_DREAMS}h)`,
    };
  }

  if (state.sessionsSinceDream < MIN_SESSIONS_BETWEEN_DREAMS) {
    return {
      due: false,
      reason: `Only ${state.sessionsSinceDream} sessions since last dream (need ${MIN_SESSIONS_BETWEEN_DREAMS})`,
    };
  }

  // Check lock without acquiring
  const lockPath = getLockPath(memoryDir);
  if (existsSync(lockPath)) {
    try {
      const stat = statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < LOCK_STALE_MS) {
        return { due: false, reason: "Dream lock is held by another process" };
      }
    } catch {
      // Ignore stat errors
    }
  }

  return { due: true, reason: "All gate conditions met" };
}

/**
 * Increment the session counter. Call this at session start.
 */
export function incrementDreamSessionCounter(memoryDir: string): void {
  const state = readDreamState(memoryDir);
  state.sessionsSinceDream += 1;
  writeDreamState(memoryDir, state);
  log.debug(
    { sessions: state.sessionsSinceDream },
    "Dream session counter incremented",
  );
}

// ── Dream Runner ───────────────────────────────────────────────────

/**
 * Run the dream consolidation cycle.
 *
 * Loads all memory files, spawns a read-only subagent to consolidate them,
 * and updates dream state on completion.
 */
export async function runDreamCycle(
  options: DreamCycleOptions,
): Promise<DreamCycleResult> {
  const { memoryDir, force } = options;

  // Gate check (unless forced)
  if (!force) {
    const gate = isDreamDue(memoryDir);
    if (!gate.due) {
      log.info({ reason: gate.reason }, "Dream cycle skipped");
      return { ran: false, summary: gate.reason, cost: 0, filesProcessed: 0 };
    }
  }

  // Acquire lock
  if (!acquireLock(memoryDir)) {
    return {
      ran: false,
      summary: "Could not acquire dream lock — another dream may be running",
      cost: 0,
      filesProcessed: 0,
    };
  }

  log.info("Dream cycle starting");

  try {
    // Load memory files directly (avoid MemoryManager which hashes projectPath)
    const rawFiles = existsSync(memoryDir)
      ? readdirSync(memoryDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => ({
            filename: f,
            content: readFileSync(join(memoryDir, f), "utf-8"),
          }))
      : [];

    if (rawFiles.length === 0) {
      log.info("No memory files to consolidate");
      return {
        ran: true,
        summary: "No memory files to consolidate",
        cost: 0,
        filesProcessed: 0,
      };
    }

    // Build the dream prompt
    const dreamPrompt = buildDreamPrompt(memoryDir, rawFiles);

    // Override session count if provided (for testing)
    const state = readDreamState(memoryDir);
    if (options.sessionCount !== undefined) {
      state.sessionsSinceDream = options.sessionCount;
    }

    // Spawn a read-only subagent for consolidation
    const result = await spawnSubagent(dreamPrompt, {
      ...options.subagentOptions,
      type: "explore",
      systemPrompt: DREAM_SYSTEM_PROMPT,
      budgetLimit: DREAM_BUDGET,
      maxSteps: 15,
    });

    // Update dream state
    const updatedState: DreamState = {
      lastDreamAt: Date.now(),
      sessionsSinceDream: 0,
    };
    writeDreamState(memoryDir, updatedState);

    const summary = result.budgetExceeded
      ? `Dream cycle completed (budget capped). Model: ${result.modelUsed}, Cost: $${result.cost.toFixed(4)}, Tool calls: ${result.toolCalls.length}. Output (partial): ${result.text.slice(0, 300)}`
      : `Dream cycle completed. Model: ${result.modelUsed}, Cost: $${result.cost.toFixed(4)}, Tool calls: ${result.toolCalls.length}. Output: ${result.text.slice(0, 500)}`;

    log.info(
      {
        cost: result.cost,
        model: result.modelUsed,
        tools: result.toolCalls.length,
        files: rawFiles.length,
      },
      "Dream cycle completed",
    );

    return {
      ran: true,
      summary,
      cost: result.cost,
      filesProcessed: rawFiles.length,
    };
  } catch (err: any) {
    log.error({ err }, "Dream cycle failed");
    return {
      ran: false,
      summary: `Dream cycle failed: ${err.message ?? "unknown error"}`,
      cost: 0,
      filesProcessed: 0,
    };
  } finally {
    releaseLock(memoryDir);
  }
}
