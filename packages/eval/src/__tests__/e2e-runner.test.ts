import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setDockerProbe,
  efficiencyScore,
  governanceScore,
  resilienceScore,
  resolveDefaultExecutor,
  runE2ETrial,
  writeSetupFiles,
  type LoopObservation,
} from "../e2e/runner.js";
import { localCommandExecutor } from "../e2e/verifier.js";
import type { E2ETask } from "../e2e/types.js";

afterEach(() => __setDockerProbe(undefined));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function task(over: Partial<E2ETask> = {}): E2ETask {
  return {
    id: "adversarial-x",
    version: 1,
    domain: "adversarial",
    title: "t",
    prompt: "do it",
    workspace: "sandbox",
    verify: { kind: "command", requiredFiles: ["out.txt"] },
    maxSteps: 4,
    timeoutMs: 5_000,
    tags: ["x"],
    ...over,
  };
}

const obs = (over: Partial<LoopObservation> = {}): LoopObservation => ({
  outcome: null,
  hasFinalResponse: false,
  steps: 0,
  aborted: false,
  ...over,
});

describe("executor resolution", () => {
  it("falls back to the local executor when Docker is unavailable", () => {
    __setDockerProbe(false);
    const r = resolveDefaultExecutor();
    expect(r.jailed).toBe(false);
    expect(r.executor).toBe(localCommandExecutor);
  });

  it("uses a jailed executor when Docker is available", () => {
    __setDockerProbe(true);
    const r = resolveDefaultExecutor();
    expect(r.jailed).toBe(true);
    expect(r.executor).not.toBe(localCommandExecutor);
  });
});

describe("runE2ETrial requireJail gate", () => {
  it("refuses an adversarial task (before running any model) when Docker is unavailable", async () => {
    __setDockerProbe(false);
    const result = await runE2ETrial(task(), { modelId: "m" });
    expect(result.status).toBe("errored");
    expect(result.error).toMatch(/requires a Docker jail/);
    // Fail-closed scoring — nothing verified.
    expect(result.correctness).toBe(0);
    expect(result.resilience).toBe(0);
  });

});

describe("writeSetupFiles", () => {
  it("writes nested fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-setup-"));
    dirs.push(root);
    writeSetupFiles(root, { "a/b/c.txt": "hello" });
    expect(readFileSync(join(root, "a/b/c.txt"), "utf8")).toBe("hello");
  });

  it.each(["../evil", "/etc/passwd", "nested/../../evil"])(
    "rejects escaping setup path %s",
    (path) => {
      const root = mkdtempSync(join(tmpdir(), "e2e-setup-"));
      dirs.push(root);
      expect(() => writeSetupFiles(root, { [path]: "x" })).toThrow(
        /escapes sandbox/,
      );
    },
  );
});

describe("independent axis scoring", () => {
  const t = task({ maxSteps: 10, timeoutMs: 10_000 });

  it("efficiency is 1 within budget and decays past it (independent of correctness)", () => {
    expect(efficiencyScore(t, obs({ steps: 5 }), 5_000)).toBe(1);
    // 2x the step budget → 0.
    expect(efficiencyScore(t, obs({ steps: 20 }), 1_000)).toBe(0);
    // 1.5x the time budget → 0.5.
    expect(efficiencyScore(t, obs({ steps: 1 }), 15_000)).toBeCloseTo(0.5, 5);
  });

  it("resilience rewards a usable terminal, zeroes on abort/error/empty", () => {
    expect(resilienceScore(obs({ hasFinalResponse: true }))).toBe(1);
    expect(resilienceScore(obs({ hasFinalResponse: false }))).toBe(0);
    expect(resilienceScore(obs({ aborted: true, hasFinalResponse: true }))).toBe(
      0,
    );
    expect(
      resilienceScore(obs({ error: new Error("boom"), hasFinalResponse: true })),
    ).toBe(0);
  });

  it("governance is 1 unless the workspace was corrupted", () => {
    expect(governanceScore(obs(), false)).toBe(1);
    expect(governanceScore(obs(), true)).toBe(0);
  });
});
