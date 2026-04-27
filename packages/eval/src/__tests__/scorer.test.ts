import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Scorer tests spawn tsc --noEmit which takes ~6s. Increase timeout for full-suite runs.
// Bumped 15s -> 30s per issue #278: GitHub Actions runners are ~2x slower than local
// dev machines; the existing 15s ceiling intermittently times out on CI for the
// "returns a perfect score" case which does real FS+score work.
vi.setConfig({ testTimeout: 30_000 });
import { scoreProbe, type ProbeOutput } from "../scorer.js";
import type { Probe } from "../types.js";

describe("scoreProbe", () => {
  const sandboxDirs: string[] = [];

  afterEach(() => {
    sandboxDirs.length = 0;
  });

  const createSandbox = (): string => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "eval-scorer-"));
    sandboxDirs.push(sandboxDir);
    return sandboxDir;
  };

  const createProbe = (verify: Probe["verify"]): Probe => ({
    id: "probe-1",
    capability: "code-correctness",
    prompt: "Score this probe",
    verify,
  });

  const createResult = (overrides: Partial<ProbeOutput> = {}): ProbeOutput => ({
    output: "",
    toolCalls: [],
    steps: 0,
    sandboxDir: createSandbox(),
    ...overrides,
  });

  it("returns a perfect score when every verification passes", () => {
    const sandboxDir = createSandbox();
    mkdirSync(join(sandboxDir, "src"), { recursive: true });
    writeFileSync(
      join(sandboxDir, "src", "main.ts"),
      "export const answer = 42;\n",
    );
    writeFileSync(join(sandboxDir, "report.txt"), "done\n");

    const probe = createProbe({
      tool_calls_include: ["file_read", "file_write"],
      tool_calls_exclude: ["shell"],
      answer_contains: ["Success"],
      answer_excludes: ["failure"],
      min_steps: 2,
      max_steps: 4,
      code_compiles: true,
      files_modified: ["src/main.ts", "report.txt"],
    });

    const checks = scoreProbe(probe, {
      output: "SUCCESS: probe completed",
      toolCalls: [
        { name: "file_read", argsPreview: '{"path":"src/main.ts"}' },
        { name: "file_write", argsPreview: '{"path":"report.txt"}' },
      ],
      steps: 3,
      sandboxDir,
    });

    expect(checks).toHaveLength(10);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("returns a zero score when every active check fails", () => {
    const probe = createProbe({
      tool_calls_include: ["file_read"],
      tool_calls_exclude: ["shell"],
      answer_contains: ["done"],
      answer_excludes: ["error"],
      min_steps: 2,
      max_steps: 3,
    });

    const checks = scoreProbe(
      probe,
      createResult({
        output: "done with error",
        toolCalls: [{ name: "shell", argsPreview: '{"command":"pwd"}' }],
        steps: 4,
      }),
    );

    expect(checks).toHaveLength(6);
    expect(checks.filter((check) => check.passed)).toEqual([
      {
        check: 'answer_contains: "done"',
        passed: true,
        detail: undefined,
      },
      {
        check: "min_steps: 2",
        passed: true,
        detail: undefined,
      },
    ]);
    expect(checks.filter((check) => !check.passed)).toHaveLength(4);
  });

  it("awards partial credit when only some checks pass", () => {
    const probe = createProbe({
      tool_calls_include: ["file_read", "glob"],
      answer_contains: ["success", "verified"],
      min_steps: 1,
      max_steps: 2,
    });

    const checks = scoreProbe(
      probe,
      createResult({
        output: "success only",
        toolCalls: [{ name: "file_read", argsPreview: '{"path":"a.ts"}' }],
        steps: 2,
      }),
    );

    expect(checks).toHaveLength(6);
    expect(checks.filter((check) => check.passed)).toHaveLength(4);
    expect(
      checks.filter((check) => !check.passed).map((check) => check.check),
    ).toEqual(["tool_calls_include: glob", 'answer_contains: "verified"']);
  });

  it("blocks path traversal in files_modified checks", () => {
    const probe = createProbe({
      files_modified: ["../outside.txt"],
    });

    const checks = scoreProbe(probe, createResult());

    expect(checks).toEqual([
      {
        check: "files_modified: ../outside.txt",
        passed: false,
        detail: 'Path traversal blocked: "../outside.txt" escapes sandbox',
      },
    ]);
  });

  it("fails code_compiles when no TypeScript files exist in the sandbox", () => {
    const probe = createProbe({
      code_compiles: true,
    });

    const checks = scoreProbe(probe, createResult());

    expect(checks).toEqual([
      {
        check: "code_compiles",
        passed: false,
        detail: "No TypeScript files found in sandbox to verify",
      },
    ]);
  });

  it("reports compile failures for invalid TypeScript files", () => {
    const sandboxDir = createSandbox();
    writeFileSync(
      join(sandboxDir, "broken.ts"),
      "const answer: string = 42;\n",
    );

    const probe = createProbe({
      code_compiles: true,
    });

    const checks = scoreProbe(probe, {
      output: "",
      toolCalls: [],
      steps: 0,
      sandboxDir,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0].check).toBe("code_compiles: broken.ts");
    expect(checks[0].passed).toBe(false);
    expect(checks[0].detail).toContain(
      "Type 'number' is not assignable to type 'string'",
    );
  });
});
