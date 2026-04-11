#!/usr/bin/env node
/**
 * Smoke test the SWE-bench Docker scorer with the gold patch.
 *
 * The gold patch is the canonical fix from the dataset — it MUST pass.
 * If this fails, the scorer is broken regardless of model output quality.
 */

import { readFileSync } from "node:fs";
import {
  scorePatch,
  instanceIdToImage,
} from "../packages/eval/dist/index.js";

const datasetPath =
  process.argv[2] ?? "eval-data/swe-bench-pytest-2.jsonl";

const lines = readFileSync(datasetPath, "utf-8").trim().split("\n");
const raw = JSON.parse(lines[0]);

// Match runner.ts loadInstances() shape so the scorer sees what it expects.
const parseTestList = (v) => {
  if (!v) return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const instance = {
  instanceId: raw.instance_id,
  repo: raw.repo,
  baseCommit: raw.base_commit,
  issue: raw.problem_statement,
  hints: raw.hints_text,
  testPatch: raw.test_patch,
  failToPass: parseTestList(raw.FAIL_TO_PASS),
  passToPass: parseTestList(raw.PASS_TO_PASS),
};

const goldPatch = {
  instanceId: instance.instanceId,
  patch: raw.patch,
  modelId: "gold",
  cost: 0,
  latencyMs: 0,
  success: true,
};

console.log("Instance:", instance.instanceId);
console.log("Image:   ", instanceIdToImage(instance.instanceId));
console.log("F2P:     ", instance.failToPass?.length, "tests");
console.log("Patch:   ", goldPatch.patch.length, "bytes (gold)");
console.log("");
console.log("Running scorer (this may take 5-15 min for first run)...\n");

const start = Date.now();
const result = scorePatch(instance, goldPatch);
const elapsed = Date.now() - start;

console.log("\n=== RESULT ===");
console.log("passed:     ", result.passed);
console.log("testsRun:   ", result.testsRun);
console.log("testsPassed:", result.testsPassed);
console.log("testsFailed:", result.testsFailed);
console.log("elapsed:    ", `${(elapsed / 1000).toFixed(1)}s`);
if (result.error) console.log("error:      ", result.error);

process.exit(result.passed ? 0 : 1);
