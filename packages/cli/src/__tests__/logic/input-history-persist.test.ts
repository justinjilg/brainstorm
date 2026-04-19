/**
 * InputHistory persistence — exercises real disk I/O via the constructor's
 * optional historyFile path.
 *
 * The sibling input-history.test.ts mocks node:fs at module load so the
 * save() path never actually touches disk. The O(N²) merge-duplication
 * regression only manifests when the real file contents are read back.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InputHistory } from "../../input-history.js";

describe("InputHistory — disk persistence (real fs)", () => {
  let tmpDir: string;
  let historyFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "br-history-test-"));
    historyFile = join(tmpDir, "input-history.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists exactly one copy of each entry across many pushes", () => {
    // Regression: the prior save() re-appended every in-memory entry to
    // fullHistory on each push. After N pushes, disk contained O(N²)
    // entries until MAX_PERSIST clipped the tail — the user's history
    // became `[A, B, C, A, B, C, D, A, B, C, D, E, …]`. Correct
    // behaviour is a single copy of each entry in insertion order.
    const h = new InputHistory(historyFile);
    for (let i = 0; i < 20; i++) {
      h.push(`cmd-${i}`);
    }

    expect(existsSync(historyFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(historyFile, "utf-8"));
    expect(persisted).toEqual(Array.from({ length: 20 }, (_, i) => `cmd-${i}`));
  });

  it("preserves history across process restarts (load → push → save)", () => {
    const h1 = new InputHistory(historyFile);
    h1.push("turn-a");
    h1.push("turn-b");

    // Simulate process restart — new instance reads the same file.
    const h2 = new InputHistory(historyFile);
    expect(h2.getAll()).toEqual(["turn-a", "turn-b"]);
    h2.push("turn-c");

    const persisted = JSON.parse(readFileSync(historyFile, "utf-8"));
    expect(persisted).toEqual(["turn-a", "turn-b", "turn-c"]);
  });

  it("deduplicates back-to-back restarts with identical tail input", () => {
    const h1 = new InputHistory(historyFile);
    h1.push("ls");
    h1.push("git status");

    const h2 = new InputHistory(historyFile);
    // User types the same command as the last persisted entry — should
    // not grow the on-disk history.
    h2.push("git status");

    const persisted = JSON.parse(readFileSync(historyFile, "utf-8"));
    expect(persisted).toEqual(["ls", "git status"]);
  });
});
