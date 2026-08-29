/**
 * Guardrail: the demoted TUI's "Glance" charter must not re-clutter.
 *
 * Two invariants the reimagining depends on:
 *  1. The slash registry stays a lean essential set (not the 40+ that mirrored
 *     the deleted dashboard/planning modes).
 *  2. The TUI top-level has NO `mode` state variable — the seam a new pane would
 *     hang on. The 4-mode switcher was removed on purpose.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSlashCommands } from "../commands/slash.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("TUI Glance charter", () => {
  it("keeps the slash registry small (≤ 10 commands)", () => {
    const cmds = getSlashCommands();
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.length).toBeLessThanOrEqual(10);
  });

  it("exposes only the essential glance commands", () => {
    const names = new Set(getSlashCommands().map((c) => c.name));
    // The lean set the demoted chat surface keeps.
    for (const essential of ["help", "model", "clear", "compact", "quit"]) {
      expect(names.has(essential)).toBe(true);
    }
    // Dashboard/planning-era commands must be gone (no surface for them).
    for (const removed of ["mode", "plan", "orchestrate", "godmode", "serve"]) {
      expect(names.has(removed)).toBe(false);
    }
  });

  it("has no `mode` state seam in the TUI top-level App", () => {
    const src = readFileSync(join(here, "../components/App.tsx"), "utf-8");
    // The deleted switcher used useMode()/a mode state + setMode.
    expect(src).not.toContain("useMode");
    expect(src).not.toMatch(/\bsetMode\b/);
    expect(src).not.toContain("ModeBar");
  });
});
