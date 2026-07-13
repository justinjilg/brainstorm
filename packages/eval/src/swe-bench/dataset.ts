/**
 * SWE-bench Verified dataset loader.
 *
 * Loads the canonical SWE-bench Verified split from a local JSONL file
 * (no network access here — the caller is responsible for having already
 * downloaded/exported the split to disk) and validates each record against
 * the fields the harness depends on: instance_id, repo, base_commit, patch,
 * test_patch, FAIL_TO_PASS, PASS_TO_PASS, problem_statement.
 *
 * Also provides a deterministic sampler (`selectDeterministicSubset`) so a
 * fixed `--split verified --limit N --seed S` selection always produces the
 * same baseline subset, regardless of the order records appear in the
 * source JSONL.
 */

import { readFileSync } from "node:fs";
import type { SWEBenchInstance } from "./runner.js";

/** Raw record shape as it appears in the SWE-bench Verified JSONL export. */
export interface RawSWEBenchRecord {
  instance_id: string;
  repo: string;
  base_commit: string;
  /** Gold/reference patch — the ground-truth fix. Not given to the agent. */
  patch: string;
  test_patch: string;
  problem_statement: string;
  FAIL_TO_PASS?: string[] | string;
  PASS_TO_PASS?: string[] | string;
  hints_text?: string;
  [key: string]: unknown;
}

/**
 * A validated SWE-bench Verified instance. Extends the harness's
 * `SWEBenchInstance` (used by `runSWEBench`/`scorePatch`) with the gold
 * patch, which the loader/scorer/dataset layer cares about but the agent
 * must never see.
 */
export interface SWEBenchVerifiedInstance extends SWEBenchInstance {
  /** Gold/reference patch (ground truth fix) — for analysis only. */
  goldPatch: string;
}

/** Thrown when a JSONL record fails schema validation. */
export class DatasetValidationError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`SWE-bench dataset validation failed at line ${line}: ${message}`);
    this.name = "DatasetValidationError";
  }
}

const REQUIRED_STRING_FIELDS = [
  "instance_id",
  "repo",
  "base_commit",
  "patch",
  "test_patch",
  "problem_statement",
] as const;

function parseTestList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Validate a single parsed JSONL record and map it onto
 * `SWEBenchVerifiedInstance`. Throws `DatasetValidationError` if any
 * required field is missing or the wrong type.
 */
export function validateRecord(
  raw: unknown,
  line: number,
): SWEBenchVerifiedInstance {
  if (raw === null || typeof raw !== "object") {
    throw new DatasetValidationError("record is not an object", line);
  }

  const record = raw as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new DatasetValidationError(
        `missing or empty required field "${field}"`,
        line,
      );
    }
  }

  return {
    instanceId: record.instance_id as string,
    repo: record.repo as string,
    baseCommit: record.base_commit as string,
    issue: record.problem_statement as string,
    hints:
      typeof record.hints_text === "string" ? record.hints_text : undefined,
    testPatch: record.test_patch as string,
    failToPass: parseTestList(record.FAIL_TO_PASS),
    passToPass: parseTestList(record.PASS_TO_PASS),
    goldPatch: record.patch as string,
  };
}

/**
 * Load and validate the full SWE-bench Verified dataset from a local JSONL
 * path. Every line must parse as JSON and satisfy `validateRecord`.
 */
export function loadVerifiedDataset(path: string): SWEBenchVerifiedInstance[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  const instances: SWEBenchVerifiedInstance[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e: any) {
      throw new DatasetValidationError(
        `invalid JSON (${e.message ?? "parse error"})`,
        i + 1,
      );
    }

    instances.push(validateRecord(raw, i + 1));
  }

  return instances;
}

/** Options for deterministic subset selection. */
export interface SelectSubsetOptions {
  /** Max number of instances to select. */
  limit: number;
  /** Seed — any string or number is accepted and hashed internally. */
  seed: number | string;
}

/**
 * Mulberry32 PRNG — small, fast, deterministic for a given 32-bit seed.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash an arbitrary string/number seed down to a 32-bit int. */
function hashSeed(seed: number | string): number {
  if (typeof seed === "number") return seed >>> 0;
  let hash = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministically sample `limit` instances from `instances` for a given
 * `seed`. Sorting by `instanceId` before shuffling means the result depends
 * only on the *set* of instances and the seed — not on the order they
 * appeared in the source JSONL — so the same (dataset, seed, limit) always
 * yields the same baseline subset. The returned subset is itself sorted by
 * `instanceId` for stable, readable output.
 */
export function selectDeterministicSubset<T extends { instanceId: string }>(
  instances: T[],
  options: SelectSubsetOptions,
): T[] {
  const { limit, seed } = options;
  if (limit <= 0 || instances.length === 0) return [];

  const sorted = [...instances].sort((a, b) =>
    a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
  );

  const rng = mulberry32(hashSeed(seed));

  // Fisher-Yates shuffle using the seeded RNG.
  const shuffled = [...sorted];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const subset = shuffled.slice(0, Math.min(limit, shuffled.length));
  subset.sort((a, b) =>
    a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
  );
  return subset;
}

/** Options for loading a baseline subset directly from disk. */
export interface LoadVerifiedSubsetOptions {
  /** Currently only "verified" is supported; reserved for future splits. */
  split?: "verified";
  limit: number;
  seed: number | string;
}

/**
 * Load the SWE-bench Verified split from `path` and deterministically
 * select a baseline subset of `limit` instances using `seed`. This is the
 * function `eval-swe-bench` (or any other caller) should use to get a
 * reproducible Verified subset without touching the network.
 */
export function loadVerifiedSubset(
  path: string,
  options: LoadVerifiedSubsetOptions,
): SWEBenchVerifiedInstance[] {
  const all = loadVerifiedDataset(path);
  return selectDeterministicSubset(all, {
    limit: options.limit,
    seed: options.seed,
  });
}
