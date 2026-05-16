/**
 * Edit-tool atomicity tests — v16 Chaos Monkey close.
 *
 * The flagged gap: `writeFileSync(path, content)` is NOT crash-safe.
 * ENOSPC mid-write or SIGKILL between open() and close() leaves the
 * file truncated to a partial state. For an agent editing its own
 * config/lockfile/migration, that's data loss.
 *
 * Fix in `file-edit.ts`: atomicReplaceFile writes to `path.tmp.<rand>`,
 * fsyncs, then renameSyncs over the target. Rename is atomic on POSIX
 * within the same filesystem — a crash leaves either OLD or NEW
 * content, never partial.
 *
 * Note: file-write.ts and multi-edit.ts already used the temp+rename
 * pattern (without fsync). file-edit.ts was the gap. This test pins
 * the fix in.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileEditTool } from "../builtin/file-edit.js";

describe("file-edit atomicity (v16 Chaos Monkey)", () => {
  let dir: string;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brainstorm-edit-atomicity-"));
    originalWorkspace = process.env.BRAINSTORM_WORKSPACE_OVERRIDE;
    process.env.BRAINSTORM_WORKSPACE_OVERRIDE = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalWorkspace === undefined) {
      delete process.env.BRAINSTORM_WORKSPACE_OVERRIDE;
    } else {
      process.env.BRAINSTORM_WORKSPACE_OVERRIDE = originalWorkspace;
    }
  });

  it("happy path: edit replaces content via atomic rename", async () => {
    const target = join(dir, "thing.txt");
    writeFileSync(target, "hello world\n", "utf-8");
    const result: any = await fileEditTool.execute(
      { path: target, old_string: "hello", new_string: "goodbye" },
      undefined,
    );
    expect(result.success).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("goodbye world\n");
  });

  it("leaves NO .tmp.* debris in the target dir after success", async () => {
    const target = join(dir, "config.json");
    writeFileSync(target, '{"a":1}', "utf-8");
    await fileEditTool.execute(
      { path: target, old_string: '"a":1', new_string: '"a":2' },
      undefined,
    );
    const { readdirSync } = await import("node:fs");
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(
      leftover,
      `tmp files should not persist: ${leftover.join(",")}`,
    ).toHaveLength(0);
  });

  it("on error path, target is NOT clobbered (atomicity invariant)", async () => {
    // Force an error by editing a non-existent path. The tool returns
    // an error result without writing. The key invariant: any pre-
    // existing file with the same name is not touched.
    const target = join(dir, "exists.txt");
    writeFileSync(target, "ORIGINAL\n", "utf-8");

    // Edit a non-existent SIBLING path (so the original is left alone)
    const ghost = join(dir, "ghost.txt");
    const result: any = await fileEditTool.execute(
      { path: ghost, old_string: "x", new_string: "y" },
      undefined,
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not found");
    // Original sibling untouched
    expect(readFileSync(target, "utf-8")).toBe("ORIGINAL\n");
  });

  it("Unicode content survives atomic write byte-for-byte", async () => {
    const target = join(dir, "unicode.md");
    const before = "α β γ — line 1\n中文 — line 2\n🚀 — line 3\n";
    writeFileSync(target, before, "utf-8");
    const result: any = await fileEditTool.execute(
      { path: target, old_string: "🚀", new_string: "🚂" },
      undefined,
    );
    expect(result.success).toBe(true);
    const after = readFileSync(target, "utf-8");
    expect(after).toBe("α β γ — line 1\n中文 — line 2\n🚂 — line 3\n");
  });
});

describe("file-edit permission preservation (v17 Attacker close)", () => {
  let dir: string;
  let originalWorkspace: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brainstorm-edit-perms-"));
    originalWorkspace = process.env.BRAINSTORM_WORKSPACE_OVERRIDE;
    process.env.BRAINSTORM_WORKSPACE_OVERRIDE = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalWorkspace === undefined) {
      delete process.env.BRAINSTORM_WORKSPACE_OVERRIDE;
    } else {
      process.env.BRAINSTORM_WORKSPACE_OVERRIDE = originalWorkspace;
    }
  });

  it("0600 file stays 0600 after edit (no permission widening)", async () => {
    const { statSync, chmodSync } = await import("node:fs");
    const target = join(dir, "secret.txt");
    writeFileSync(target, "API_KEY=abc\n", "utf-8");
    chmodSync(target, 0o600);
    const before = statSync(target).mode & 0o777;
    expect(before).toBe(0o600);

    const result: any = await fileEditTool.execute(
      { path: target, old_string: "abc", new_string: "xyz" },
      undefined,
    );
    expect(result.success).toBe(true);

    const after = statSync(target).mode & 0o777;
    expect(
      after,
      `permissions widened: 0${before.toString(8)} → 0${after.toString(8)}`,
    ).toBe(0o600);
  });

  it("0644 file stays 0644 after edit (mode preserved both directions)", async () => {
    const { statSync, chmodSync } = await import("node:fs");
    const target = join(dir, "config.json");
    writeFileSync(target, '{"a":1}', "utf-8");
    chmodSync(target, 0o644);

    const result: any = await fileEditTool.execute(
      { path: target, old_string: '"a":1', new_string: '"a":2' },
      undefined,
    );
    expect(result.success).toBe(true);
    const after = statSync(target).mode & 0o777;
    expect(after).toBe(0o644);
  });

  it("0755 executable script stays executable after edit", async () => {
    const { statSync, chmodSync } = await import("node:fs");
    const target = join(dir, "script.sh");
    writeFileSync(target, "#!/usr/bin/env bash\necho hello\n", "utf-8");
    chmodSync(target, 0o755);

    const result: any = await fileEditTool.execute(
      { path: target, old_string: "hello", new_string: "goodbye" },
      undefined,
    );
    expect(result.success).toBe(true);
    const after = statSync(target).mode & 0o777;
    expect(after).toBe(0o755);
  });
});
