import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  E2EDatasetError,
  loadE2EDataset,
  validateE2ETask,
} from "../e2e/dataset.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "coding-example",
    version: 1,
    domain: "coding",
    title: "Example",
    prompt: "Implement the requested behavior.",
    workspace: "sandbox",
    verify: {
      kind: "command",
      requiredFiles: ["src/index.ts"],
      commands: ["node --test"],
      fileAssertions: [{ path: "src/index.ts", contains: ["export"] }],
    },
    maxSteps: 20,
    timeoutMs: 60_000,
    tags: ["deterministic"],
    ...overrides,
  };
}

describe("validateE2ETask", () => {
  it("preserves the complete deterministic verification contract", () => {
    expect(validateE2ETask(task()).verify).toEqual({
      kind: "command",
      requiredFiles: ["src/index.ts"],
      commands: ["node --test"],
      fileAssertions: [
        {
          path: "src/index.ts",
          contains: ["export"],
          excludes: undefined,
        },
      ],
      rubric: undefined,
      noMutation: undefined,
    });
  });

  it.each(["../outside", "/tmp/outside", "nested/../../outside"])(
    "rejects setup path %s that escapes the sandbox",
    (path) => {
      expect(() =>
        validateE2ETask(task({ setup: { files: { [path]: "content" } } })),
      ).toThrow(/inside the sandbox/);
    },
  );

  it("rejects unknown rubrics instead of silently dropping them", () => {
    expect(() =>
      validateE2ETask(
        task({ verify: { kind: "document", rubric: "looks-good-v1" } }),
      ),
    ).toThrow(/unknown rubric/);
  });
});

describe("loadE2EDataset", () => {
  it("reports duplicate ids with the source line", () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstorm-e2e-"));
    tempDirs.push(dir);
    const path = join(dir, "suite.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(task())}\n${JSON.stringify(task())}\n`,
    );

    expect(() => loadE2EDataset(path)).toThrow(
      new E2EDatasetError("duplicate task id: coding-example", 2),
    );
  });

  it("loads the frozen v1 suite with its promised distribution", () => {
    const path = resolve(process.cwd(), "../../eval-data/kernel-e2e-v1.jsonl");
    const tasks = loadE2EDataset(path);
    const counts = Object.fromEntries(
      ["coding", "web", "documentation", "infrastructure", "adversarial"].map(
        (domain) => [
          domain,
          tasks.filter((task) => task.domain === domain).length,
        ],
      ),
    );

    expect(tasks).toHaveLength(30);
    expect(counts).toEqual({
      coding: 10,
      web: 8,
      documentation: 5,
      infrastructure: 4,
      adversarial: 3,
    });
  });
});
