/**
 * Memory Curator Runner — incremental memory tidying after active sessions.
 *
 * Unlike the dream cycle (deep consolidation every 24h/5 sessions), the curator
 * runs post-session when 3+ memory operations occurred. It focuses on recently-
 * modified files only — dedup, contradiction resolution, tier promotion/demotion.
 *
 * Follows the same lock/state pattern as dream-runner.ts.
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
import { CURATOR_SYSTEM_PROMPT, buildCuratorPrompt } from "./curator-prompt.js";
import { spawnSubagent, type SubagentOptions } from "../agent/subagent.js";

const log = createLogger("curator-runner");

// ── Constants ──────────────────────────────────────────────────────

const CURATOR_STATE_FILE = ".curator-state.json";
const CURATOR_LOCK_FILE = ".curator-lock";
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const CURATOR_BUDGET = 0.02; // $0.02 max per cycle
const MIN_MEMORY_OPS = 3; // Minimum memory operations to trigger

// ── Types ──────────────────────────────────────────────────────────

interface CuratorState {
  lastCuratorAt: number; // epoch ms
}

export interface CuratorCycleOptions {
  memoryDir: string;
  sessionMemoryOps: number;
  /** Session start time — only files modified after this are considered */
  sessionStartMs: number;
  /** Skip gate checks (force run) */
  force?: boolean;
  subagentOptions: Omit<
    SubagentOptions,
    "type" | "systemPrompt" | "budgetLimit" | "maxSteps"
  >;
}

export interface CuratorCycleResult {
  ran: boolean;
  summary: string;
  cost: number;
  filesProcessed: number;
}

// ── State & Lock ──────────────────────────────────────────────────

function readState(memoryDir: string): CuratorState {
  const path = join(memoryDir, CURATOR_STATE_FILE);
  if (!existsSync(path)) return { lastCuratorAt: 0 };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CuratorState;
  } catch {
    return { lastCuratorAt: 0 };
  }
}

function writeState(memoryDir: string, state: CuratorState): void {
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    join(memoryDir, CURATOR_STATE_FILE),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

function acquireLock(memoryDir: string): boolean {
  const lockPath = join(memoryDir, CURATOR_LOCK_FILE);

  if (existsSync(lockPath)) {
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        log.info("Curator lock held by another process — skipping");
        return false;
      }
      log.warn("Stale curator lock found, overriding");
    } catch {
      // stat failed — proceed
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
    log.error({ err }, "Failed to acquire curator lock");
    return false;
  }
}

function releaseLock(memoryDir: string): void {
  const lockPath = join(memoryDir, CURATOR_LOCK_FILE);
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch (err) {
    log.warn({ err }, "Failed to release curator lock");
  }
}

// ── Runner ────────────────────────────────────────────────────────

/**
 * Run the curator cycle if gate conditions are met.
 */
export async function runCuratorCycle(
  options: CuratorCycleOptions,
): Promise<CuratorCycleResult> {
  const { memoryDir, sessionMemoryOps, sessionStartMs, force } = options;

  // Gate check
  if (!force && sessionMemoryOps < MIN_MEMORY_OPS) {
    return {
      ran: false,
      summary: `Only ${sessionMemoryOps} memory ops (need ${MIN_MEMORY_OPS})`,
      cost: 0,
      filesProcessed: 0,
    };
  }

  if (!acquireLock(memoryDir)) {
    return {
      ran: false,
      summary: "Could not acquire curator lock",
      cost: 0,
      filesProcessed: 0,
    };
  }

  log.info({ memoryOps: sessionMemoryOps }, "Curator cycle starting");

  try {
    // Find memory files modified since session start
    const recentFiles = getRecentMemoryFiles(memoryDir, sessionStartMs);

    if (recentFiles.length === 0) {
      log.info("No recently-modified memory files to curate");
      return {
        ran: true,
        summary: "No recent memory files to curate",
        cost: 0,
        filesProcessed: 0,
      };
    }

    const curatorPrompt = buildCuratorPrompt(memoryDir, recentFiles);

    const result = await spawnSubagent(curatorPrompt, {
      ...options.subagentOptions,
      type: "memory-curator",
      systemPrompt: CURATOR_SYSTEM_PROMPT,
      budgetLimit: CURATOR_BUDGET,
      maxSteps: 5,
    });

    // Update state
    writeState(memoryDir, { lastCuratorAt: Date.now() });

    const summary = `Curator completed. Model: ${result.modelUsed}, Cost: $${result.cost.toFixed(4)}, Tool calls: ${result.toolCalls.length}, Files reviewed: ${recentFiles.length}`;
    log.info(
      {
        cost: result.cost,
        model: result.modelUsed,
        tools: result.toolCalls.length,
        files: recentFiles.length,
      },
      "Curator cycle completed",
    );

    return {
      ran: true,
      summary,
      cost: result.cost,
      filesProcessed: recentFiles.length,
    };
  } catch (err: any) {
    log.error({ err }, "Curator cycle failed");
    return {
      ran: false,
      summary: `Curator failed: ${err.message ?? "unknown error"}`,
      cost: 0,
      filesProcessed: 0,
    };
  } finally {
    releaseLock(memoryDir);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Find .md files in the memory directory modified after sessionStartMs.
 * Searches all tier subdirectories (system/, archive/) and root.
 */
function getRecentMemoryFiles(
  memoryDir: string,
  sessionStartMs: number,
): Array<{ filename: string; content: string }> {
  const results: Array<{ filename: string; content: string }> = [];

  const dirs = [memoryDir];
  for (const sub of ["system", "archive"]) {
    const subDir = join(memoryDir, sub);
    if (existsSync(subDir)) dirs.push(subDir);
  }

  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(dir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs >= sessionStartMs) {
            results.push({
              filename:
                dir === memoryDir ? file : `${dir.split("/").pop()}/${file}`,
              content: readFileSync(filePath, "utf-8"),
            });
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Skip dirs we can't read
    }
  }

  return results;
}
