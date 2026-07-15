/**
 * LLM-based memory extraction runner — async cheap-model pass over session
 * transcripts to pull out durable memories the regex middleware
 * (packages/core/src/middleware/builtin/memory-extract.ts) would miss.
 *
 * Follows the same lock/state pattern as curator-runner.ts (see that file
 * for the PID-ownership rationale on lock release — not duplicated here).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "@brainst0rm/shared";
import { EXTRACT_SYSTEM_PROMPT, buildExtractPrompt } from "./extract-prompt.js";
import { spawnSubagent, type SubagentOptions } from "../agent/subagent.js";
import type { MemoryManager } from "./manager.js";

const log = createLogger("extract-runner");

// ── Constants ──────────────────────────────────────────────────────

export const EXTRACT_STATE_FILE = ".extract-state.json";
export const EXTRACT_LOCK_FILE = ".extract-lock";
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
export const MIN_TURNS = 5;
export const EXTRACT_BUDGET = 0.02; // $0.02 max per cycle

// ── Types ──────────────────────────────────────────────────────────

interface ExtractState {
  lastExtractAt: number; // epoch ms
  turnsSince: number;
  /**
   * Transcripts from sub-threshold sessions, concatenated and awaiting the next
   * extraction. Without this, five one-turn `brainstorm run` calls would reach
   * the turn threshold on the fifth but only extract from that fifth
   * transcript, permanently dropping the durable facts from sessions 1–4.
   */
  pendingTranscript?: string;
}

/** Cap on the accumulated pending transcript, oldest content trimmed first. */
const MAX_PENDING_TRANSCRIPT = 40_000;

interface ExtractedItem {
  type: "user" | "project" | "feedback" | "reference";
  name: string;
  description: string;
  content: string;
}

const VALID_ITEM_TYPES = ["user", "project", "feedback", "reference"] as const;

export interface ExtractCycleOptions {
  memoryDir: string;
  memoryManager: MemoryManager;
  transcript: string;
  sessionTurns: number;
  /** Skip gate checks (force run) */
  force?: boolean;
  subagentOptions: Omit<
    SubagentOptions,
    "type" | "systemPrompt" | "budgetLimit" | "maxSteps"
  >;
}

export interface ExtractCycleResult {
  ran: boolean;
  summary: string;
  cost: number;
  extracted: number;
}

// ── State & Lock ──────────────────────────────────────────────────

function readState(memoryDir: string): ExtractState {
  const statePath = join(memoryDir, EXTRACT_STATE_FILE);
  if (!existsSync(statePath)) {
    return { lastExtractAt: 0, turnsSince: 0, pendingTranscript: "" };
  }
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExtractState>;
    return {
      lastExtractAt: parsed.lastExtractAt ?? 0,
      turnsSince: parsed.turnsSince ?? 0,
      pendingTranscript: parsed.pendingTranscript ?? "",
    };
  } catch {
    return { lastExtractAt: 0, turnsSince: 0, pendingTranscript: "" };
  }
}

function writeState(memoryDir: string, state: ExtractState): void {
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    join(memoryDir, EXTRACT_STATE_FILE),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

// Lock acquire/release follows the same PID-ownership pattern as
// curator-runner.ts's acquireLock/releaseLock — see that file for the
// race-condition rationale (process-A wakeup-unlink-of-B).

function acquireLock(memoryDir: string): boolean {
  const lockPath = join(memoryDir, EXTRACT_LOCK_FILE);

  if (existsSync(lockPath)) {
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        log.info("Extraction lock held by another process — skipping");
        return false;
      }
      log.warn("Stale extraction lock found, overriding");
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process may have unlinked it first; O_EXCL below
        // is the authoritative race-winner check.
      }
    } catch {
      // stat failed — proceed
    }
  }

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      log.info(
        "Extraction lock acquired by another process in the race window",
      );
    } else {
      log.error({ err }, "Failed to acquire extraction lock");
    }
    return false;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseLock(memoryDir: string): void {
  const lockPath = join(memoryDir, EXTRACT_LOCK_FILE);
  if (!existsSync(lockPath)) return;
  let ownPid: number | undefined;
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: number };
    ownPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch (err) {
    log.warn(
      { err },
      "Extraction lock unreadable on release; leaving in place for stale-window recovery",
    );
    return;
  }
  if (ownPid !== process.pid) {
    log.warn(
      { lockPid: ownPid, ownPid: process.pid },
      "Extraction lock owned by different PID; refusing to release",
    );
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (err) {
    log.warn({ err }, "Failed to release extraction lock");
  }
}

// ── Parsing ───────────────────────────────────────────────────────

/**
 * Parse the model's text output as a JSON array, tolerating markdown code
 * fences (```json ... ``` or ``` ... ```). Returns null on parse failure.
 */
function parseExtractedItems(text: string): ExtractedItem[] | null {
  let raw = text.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (item): item is ExtractedItem =>
        item &&
        typeof item === "object" &&
        typeof item.type === "string" &&
        (VALID_ITEM_TYPES as readonly string[]).includes(item.type) &&
        typeof item.name === "string" &&
        item.name.trim().length > 0 &&
        typeof item.description === "string" &&
        typeof item.content === "string",
    );
  } catch {
    return null;
  }
}

// ── Runner ────────────────────────────────────────────────────────

/**
 * Run the LLM extraction cycle if gate conditions are met.
 */
export async function runExtractionCycle(
  options: ExtractCycleOptions,
): Promise<ExtractCycleResult> {
  const { memoryDir, memoryManager, transcript, sessionTurns, force } = options;

  const state = readState(memoryDir);
  const turnsSince = state.turnsSince + sessionTurns;

  // Accumulate this session's transcript with prior sub-threshold ones, newest
  // last, trimmed from the head to the cap.
  let pendingTranscript = [state.pendingTranscript ?? "", transcript]
    .filter((s) => s.length > 0)
    .join("\n\n");
  if (pendingTranscript.length > MAX_PENDING_TRANSCRIPT) {
    pendingTranscript = pendingTranscript.slice(
      pendingTranscript.length - MAX_PENDING_TRANSCRIPT,
    );
  }

  // Gate check
  if (!force && turnsSince < MIN_TURNS) {
    writeState(memoryDir, {
      lastExtractAt: state.lastExtractAt,
      turnsSince,
      pendingTranscript,
    });
    return {
      ran: false,
      summary: `Only ${turnsSince} turns since last extraction (need ${MIN_TURNS})`,
      cost: 0,
      extracted: 0,
    };
  }

  // Persist the accumulated turn count + transcript before attempting the lock
  // so contention or a later failure doesn't silently drop this call's turns or
  // sessions. The success path below resets both once extraction completes.
  writeState(memoryDir, {
    lastExtractAt: state.lastExtractAt,
    turnsSince,
    pendingTranscript,
  });

  if (!acquireLock(memoryDir)) {
    return {
      ran: false,
      summary: "Could not acquire extraction lock",
      cost: 0,
      extracted: 0,
    };
  }

  log.info({ turnsSince }, "Extraction cycle starting");

  try {
    const memoryIndexPath = join(memoryDir, "MEMORY.md");
    const memoryIndex = existsSync(memoryIndexPath)
      ? readFileSync(memoryIndexPath, "utf-8")
      : "";

    // Extract over the full accumulated transcript, not just this session's.
    const extractPrompt = buildExtractPrompt(pendingTranscript, memoryIndex);

    const result = await spawnSubagent(extractPrompt, {
      ...options.subagentOptions,
      type: "explore",
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      budgetLimit: EXTRACT_BUDGET,
      maxSteps: 3,
    });

    const items = parseExtractedItems(result.text);

    if (items === null) {
      log.warn(
        "Extraction model output failed to parse as JSON — writing nothing",
      );
      writeState(memoryDir, {
        lastExtractAt: Date.now(),
        turnsSince: 0,
        pendingTranscript: "",
      });
      return {
        ran: true,
        summary: "Extraction output could not be parsed — nothing saved",
        cost: result.cost,
        extracted: 0,
      };
    }

    let extracted = 0;
    const existingNames = new Set(memoryManager.list().map((m) => m.name));
    for (const item of items) {
      if (existingNames.has(item.name)) continue;
      try {
        memoryManager.save({
          type: item.type,
          name: item.name,
          description: item.description,
          content: item.content,
          source: "llm_extraction",
          author: "extract-runner",
        });
        existingNames.add(item.name);
        extracted++;
      } catch (err: any) {
        log.warn(
          { err, name: item.name },
          "Skipping memory item — save failed (likely slug collision)",
        );
      }
    }

    writeState(memoryDir, {
      lastExtractAt: Date.now(),
      turnsSince: 0,
      pendingTranscript: "",
    });

    const summary = `Extraction completed. Model: ${result.modelUsed}, Cost: $${result.cost.toFixed(4)}, Extracted: ${extracted}/${items.length}`;
    log.info(
      {
        cost: result.cost,
        model: result.modelUsed,
        extracted,
        found: items.length,
      },
      "Extraction cycle completed",
    );

    return {
      ran: true,
      summary,
      cost: result.cost,
      extracted,
    };
  } catch (err: any) {
    log.error({ err }, "Extraction cycle failed");
    return {
      ran: false,
      summary: `Extraction failed: ${err.message ?? "unknown error"}`,
      cost: 0,
      extracted: 0,
    };
  } finally {
    releaseLock(memoryDir);
  }
}
