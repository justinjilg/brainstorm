import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotSandbox, verifyE2EArtifact } from "../e2e/verifier.js";
import type { E2ETask } from "../e2e/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "brainstorm-verify-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function task(overrides: Partial<E2ETask> = {}): E2ETask {
  return {
    id: "coding-verifier",
    version: 1,
    domain: "coding",
    title: "Verifier fixture",
    prompt: "Make the tests pass.",
    workspace: "sandbox",
    verify: {
      kind: "command",
      requiredFiles: ["src/value.js"],
      commands: ["node --test"],
      fileAssertions: [{ path: "src/value.js", contains: ["export"] }],
    },
    maxSteps: 10,
    timeoutMs: 5_000,
    tags: ["test"],
    ...overrides,
  };
}

describe("verifyE2EArtifact", () => {
  it("runs deterministic commands and hashes verified artifacts", async () => {
    const root = workspace({
      "package.json": '{"type":"module"}',
      "src/value.js": "export const value = 7;\n",
      "value.test.js":
        "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './src/value.js'; test('value',()=>assert.equal(value,7));\n",
    });

    const result = await verifyE2EArtifact(task(), root);

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "command:node --test", passed: true }),
      ]),
    );
    expect(result.artifacts[0]).toMatchObject({
      path: "src/value.js",
      bytes: 24,
    });
    expect(result.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects mutation of setup fixtures not declared as editable artifacts", async () => {
    const originalTest = "assert.equal(value, 7);\n";
    const root = workspace({
      "src/value.js": "export const value = 7;\n",
      "test/value.test.js": "// weakened\n",
    });
    const result = await verifyE2EArtifact(
      task({
        setup: {
          files: {
            "src/value.js": "export const value = 0;\n",
            "test/value.test.js": originalTest,
          },
        },
        verify: {
          kind: "command",
          requiredFiles: ["src/value.js"],
          fileAssertions: [],
        },
      }),
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "fixture:test/value.test.js",
        passed: false,
      }),
    );
    expect(
      result.checks.find((check) => check.id === "fixture:src/value.js"),
    ).toBeUndefined();
  });

  it("rejects required-file symlinks that escape the sandbox", async () => {
    const outside = workspace({ "secret.txt": "secret" });
    const root = workspace({});
    symlinkSync(join(outside, "secret.txt"), join(root, "result.txt"));

    const result = await verifyE2EArtifact(
      task({
        verify: { kind: "document", requiredFiles: ["result.txt"] },
      }),
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toMatch(/symlink escapes sandbox/);
    expect(result.artifacts).toEqual([]);
  });

  it("parses structured JSON rather than accepting a matching substring", async () => {
    const root = workspace({ "changeset.json": '{"approval": true' });
    const result = await verifyE2EArtifact(
      task({
        domain: "infrastructure",
        verify: {
          kind: "structured-data",
          requiredFiles: ["changeset.json"],
          fileAssertions: [{ path: "changeset.json", contains: ["approval"] }],
        },
      }),
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "json:changeset.json", passed: false }),
    );
  });

  it("enforces baseline web document and viewport structure", async () => {
    const root = workspace({ "index.html": "<main>Hello</main>" });
    const result = await verifyE2EArtifact(
      task({
        domain: "web",
        verify: { kind: "static-web", requiredFiles: ["index.html"] },
      }),
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "web:document", passed: false }),
        expect.objectContaining({ id: "web:viewport", passed: false }),
      ]),
    );
  });

  it("requires and compares a pre-run snapshot for no-mutation tasks", async () => {
    const root = workspace({ "input.txt": "unchanged" });
    const before = snapshotSandbox(root);
    const unchanged = await verifyE2EArtifact(
      task({
        verify: {
          kind: "policy",
          fileAssertions: [{ path: "input.txt", contains: ["unchanged"] }],
          noMutation: true,
        },
      }),
      root,
      { beforeSnapshot: before },
    );
    writeFileSync(join(root, "extra.txt"), "mutation");
    const changed = await verifyE2EArtifact(
      task({
        verify: {
          kind: "policy",
          fileAssertions: [{ path: "input.txt", contains: ["unchanged"] }],
          noMutation: true,
        },
      }),
      root,
      { beforeSnapshot: before },
    );

    expect(unchanged.passed).toBe(true);
    expect(changed.passed).toBe(false);
    expect(changed.checks.at(-1)).toMatchObject({
      id: "workspace:no-mutation",
      passed: false,
    });
  });

  it("refuses unapproved verifier executables without invoking a shell", async () => {
    const root = workspace({ "src/value.js": "export const value = 7;\n" });
    const result = await verifyE2EArtifact(
      task({ verify: { kind: "command", commands: ["sh -c 'exit 0'"] } }),
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toMatch(/not allowed/);
  });
});
