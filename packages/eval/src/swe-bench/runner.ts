/**
 * SWE-bench Evaluation Runner.
 *
 * Downloads SWE-bench instances, applies Brainstorm agent to each,
 * captures patches. Uses Docker for isolation.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SWEBenchInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
  issue: string;
  hints?: string;
  testPatch: string;
  /** Tests that must pass AFTER the fix (fail BEFORE). JSON-encoded string[]. */
  failToPass?: string[];
  /** Tests that must still pass AFTER the fix (regression check). JSON-encoded string[]. */
  passToPass?: string[];
}

export interface SWEBenchPatch {
  instanceId: string;
  patch: string;
  model: string;
  strategy: string;
  cost: number;
  latencyMs: number;
  success: boolean;
}

const EVAL_DIR = join(homedir(), ".brainstorm", "eval", "swe-bench");

/**
 * Run SWE-bench evaluation on a set of instances.
 *
 * @param instances - SWE-bench instances to evaluate
 * @param agentFn - Function that runs the agent on an instance and returns a patch
 * @param concurrency - Number of parallel evaluations
 */
export async function runSWEBench(
  instances: SWEBenchInstance[],
  agentFn: (instance: SWEBenchInstance) => Promise<SWEBenchPatch>,
  concurrency = 2,
): Promise<SWEBenchPatch[]> {
  if (!existsSync(EVAL_DIR)) {
    mkdirSync(EVAL_DIR, { recursive: true });
  }

  const results: SWEBenchPatch[] = [];
  const queue = [...instances];

  // Process in batches for controlled concurrency
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((instance) => agentFn(instance)),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        // Record failed instance
        results.push({
          instanceId:
            batch[batchResults.indexOf(result)]?.instanceId ?? "unknown",
          patch: "",
          model: "",
          strategy: "",
          cost: 0,
          latencyMs: 0,
          success: false,
        });
      }
    }
  }

  // Save predictions
  const predictionsPath = join(EVAL_DIR, `predictions-${Date.now()}.json`);
  writeFileSync(predictionsPath, JSON.stringify(results, null, 2));

  return results;
}

/**
 * Load SWE-bench instances from a JSONL file.
 */
export function loadInstances(
  path: string,
  limit?: number,
): SWEBenchInstance[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const instances: SWEBenchInstance[] = lines.map((line) => {
    const data = JSON.parse(line);
    // FAIL_TO_PASS / PASS_TO_PASS arrive as JSON-encoded strings in the
    // parquet dataset; parse them into arrays.
    const parseTestList = (raw: unknown): string[] | undefined => {
      if (!raw) return undefined;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    return {
      instanceId: data.instance_id,
      repo: data.repo,
      baseCommit: data.base_commit,
      issue: data.problem_statement,
      hints: data.hints_text,
      testPatch: data.test_patch,
      failToPass: parseTestList(data.FAIL_TO_PASS),
      passToPass: parseTestList(data.PASS_TO_PASS),
    };
  });

  return limit ? instances.slice(0, limit) : instances;
}

/**
 * Get the path to the SWE-bench eval directory.
 */
export function getEvalDir(): string {
  return EVAL_DIR;
}
