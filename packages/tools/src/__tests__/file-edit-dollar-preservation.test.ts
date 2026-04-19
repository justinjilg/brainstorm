/**
 * File-edit $-backreference preservation trap.
 *
 * Real bug class: String.prototype.replace with a string replacement
 * argument interprets $1/$2/$&/$`/$' as regex-backreference specials.
 * For file_edit and multi_edit, new_string is a user/agent-provided
 * LITERAL — it should be written to the file verbatim. Pre-fix, any
 * `$N` sequence in new_string was stripped (unmatched backrefs) or
 * partially substituted (`$&` → full match of old_string).
 *
 * Examples of content that hits this in practice:
 *   - Regex patterns:  `/^(foo)$/`, `$\d+`, `$(name)`, `$&amp;`
 *   - Shell vars:      `${HOME}`, `$USER`, `$?`
 *   - jQuery / Zepto:  `$(".selector")`
 *   - Template literals that survived extraction: `${value}`
 *   - Bitcoin / Stripe IDs: `$ch_1AbCd`
 *
 * Fix applied in edit-common.ts and file-edit.ts: use the
 * FUNCTION form — `replace(old, () => new)`. This trap holds
 * that contract.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileEditTool } from "../builtin/file-edit.js";
import { applyEdit } from "../builtin/edit-common.js";

describe("file edit — $-backreference preservation", () => {
  describe("applyEdit (edit-common)", () => {
    it("preserves literal $1 in new_string", () => {
      const result = applyEdit("replace me", "replace me", "match: $1");
      expect(result.applied).toBe(true);
      expect(result.content).toBe("match: $1");
    });
    it("preserves $& (would have meant 'full match' in string-form replace)", () => {
      const result = applyEdit("abc", "abc", "X$&Y");
      expect(result.applied).toBe(true);
      expect(result.content).toBe("X$&Y");
    });
    it("preserves shell variable $HOME", () => {
      const result = applyEdit("TODO", "TODO", 'echo "$HOME"');
      expect(result.applied).toBe(true);
      expect(result.content).toBe('echo "$HOME"');
    });
    it("preserves regex pattern with $\\d", () => {
      const result = applyEdit("PATTERN", "PATTERN", "/\\$(\\d+)/g");
      expect(result.applied).toBe(true);
      expect(result.content).toBe("/\\$(\\d+)/g");
    });
  });

  describe("fileEditTool", () => {
    it("writes $-containing content to disk verbatim", async () => {
      const dir = mkdtempSync(join(tmpdir(), "file-edit-dollar-"));
      const target = join(dir, "regex.ts");
      writeFileSync(target, 'const pattern = "TODO_PLACEHOLDER";\n', "utf-8");
      const newCode = "const pattern = /^\\$(\\d+)\\.(\\d+)$/;";
      const result = await fileEditTool.execute({
        path: target,
        old_string: 'const pattern = "TODO_PLACEHOLDER";',
        new_string: newCode,
      });
      // Tool should succeed; error property absent
      expect((result as any)?.error).toBeUndefined();
      // File content must contain the $-patterns as written
      const disk = readFileSync(target, "utf-8");
      expect(disk).toContain("\\$(\\d+)\\.(\\d+)");
      expect(disk).toContain(newCode);
    });
  });
});
