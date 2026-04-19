/**
 * Sensitive-path protection trap for file tools.
 *
 * Closes a finding from the F5 self-probe: the shell sandbox blocks
 * `cat ~/.ssh/id_rsa`, but `file_read({ path: "~/.ssh/id_rsa" })`
 * bypassed the shell entirely and read the file directly. Three file
 * tools shared the same `ensureSafePath()` gap: file-read.ts,
 * file-edit.ts, file-write.ts — all allowed anything under $HOME.
 *
 * This trap exercises the shared `sensitive-paths.ts` block module
 * against each file tool, proving:
 *   1. Reading sensitive files is blocked (.ssh, .aws, .netrc, .npmrc)
 *   2. Writing to them is ALSO blocked (file_write could overwrite
 *      ~/.ssh/authorized_keys to persist an attacker's key)
 *   3. Editing them is blocked
 *   4. Legitimate home-directory reads still work
 */

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileReadTool } from "../builtin/file-read.js";
import { fileWriteTool } from "../builtin/file-write.js";
import { fileEditTool } from "../builtin/file-edit.js";
import { multiEditTool } from "../builtin/multi-edit.js";

const HOME = homedir();

function isBlocked(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  const msg = typeof result.error === "string" ? result.error : "";
  return msg.startsWith("Path blocked");
}

describe("file tools — sensitive-path blocks", () => {
  describe("file_read", () => {
    it("blocks reading ~/.ssh/id_rsa", async () => {
      const result = await fileReadTool.execute({
        path: join(HOME, ".ssh", "id_rsa"),
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("blocks reading ~/.aws/credentials", async () => {
      const result = await fileReadTool.execute({
        path: join(HOME, ".aws", "credentials"),
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("blocks reading ~/.netrc", async () => {
      const result = await fileReadTool.execute({
        path: join(HOME, ".netrc"),
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("blocks reading ~/.npmrc", async () => {
      const result = await fileReadTool.execute({
        path: join(HOME, ".npmrc"),
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("still allows reading ~/.brainstorm/config (false-positive guard)", async () => {
      // This directory isn't in the sensitive list. The read might
      // fail with ENOENT on a clean install, but it MUST NOT be
      // blocked with a "Path blocked" message.
      const result = await fileReadTool.execute({
        path: join(HOME, ".brainstorm", "config.toml"),
      });
      expect(isBlocked(result)).toBe(false);
    });
  });

  describe("file_write", () => {
    it("blocks writing to ~/.ssh/authorized_keys (persistence vector)", async () => {
      // Overwriting authorized_keys is a classic persistence attack.
      // Just as dangerous as reading id_rsa.
      const result = await fileWriteTool.execute({
        path: join(HOME, ".ssh", "authorized_keys"),
        content: "attacker-pubkey\n",
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("blocks writing to ~/.aws/credentials", async () => {
      const result = await fileWriteTool.execute({
        path: join(HOME, ".aws", "credentials"),
        content: "[default]\naws_access_key_id=ATTACKER\n",
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("still allows writing to a tmp dir (false-positive guard)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "brainstorm-file-write-probe-"));
      const target = join(dir, "out.txt");
      const result = await fileWriteTool.execute({
        path: target,
        content: "hello",
      });
      expect(isBlocked(result)).toBe(false);
    });
  });

  describe("file_edit", () => {
    it("blocks editing ~/.ssh/config", async () => {
      const result = await fileEditTool.execute({
        path: join(HOME, ".ssh", "config"),
        old_string: "Host *",
        new_string: "Host attacker.example.com\nHost *",
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("still allows editing a tmp file (false-positive guard)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "brainstorm-file-edit-probe-"));
      const target = join(dir, "edit-probe.txt");
      writeFileSync(target, "hello world\n");
      const result = await fileEditTool.execute({
        path: target,
        old_string: "hello",
        new_string: "goodbye",
      });
      expect(isBlocked(result)).toBe(false);
    });
  });

  describe("multi_edit", () => {
    // multi_edit had the same F5 gap as the single file_edit before
    // acfe878 + 850abd8 + this commit. An attacker using multi_edit
    // to slip credential-file edits past the scan would have the
    // same exfil/persistence vector.
    it("blocks editing ~/.ssh/authorized_keys", async () => {
      const result = await multiEditTool.execute({
        path: join(HOME, ".ssh", "authorized_keys"),
        edits: [
          {
            old_string: "existing-key",
            new_string: "attacker-key\nexisting-key",
          },
        ],
      });
      expect(isBlocked(result)).toBe(true);
    });
    it("still allows editing a tmp file (false-positive guard)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "brainstorm-multi-edit-probe-"));
      const target = join(dir, "multi-probe.txt");
      writeFileSync(target, "a b c\n");
      const result = await multiEditTool.execute({
        path: target,
        edits: [{ old_string: "a", new_string: "A" }],
      });
      expect(isBlocked(result)).toBe(false);
    });
  });
});
