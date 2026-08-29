/**
 * CLI calm-surface charter (Phase 4: "The Substrate").
 *
 * The front door must stay CALM — a small, deliberate core in `--help` — while
 * NOTHING is actually removed (advanced verbs stay registered, functional, and
 * `--help`-discoverable per command). This test pins both halves so the surface
 * can't quietly re-bloat and a command can't be silently dropped under the guise
 * of "hiding" it.
 */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  CORE_COMMANDS,
  applyCalmSurface,
  registerCommandsIndex,
} from "../commands/surface.js";
import { registerAllCommands } from "../commands/registry.js";

/** Build the program exactly as the entry does — the shared registrar list plus
 * the meta `commands` index — so this charter can't drift from the real CLI. */
function buildProgram(): Command {
  const program = new Command();
  registerAllCommands(program);
  registerCommandsIndex(program);
  return program;
}

const isHidden = (c: Command) =>
  (c as unknown as { _hidden?: boolean })._hidden === true;

describe("CLI calm-surface charter", () => {
  it("core is small and deliberate (≤ 16 verbs on the front door)", () => {
    expect(CORE_COMMANDS.length).toBeLessThanOrEqual(16);
  });

  it("shows only the core in --help, hides the rest — but removes nothing", () => {
    const program = buildProgram();
    const before = program.commands.map((c) => c.name()).sort();
    const hidden = applyCalmSurface(program);
    const after = program.commands.map((c) => c.name()).sort();

    // Nothing removed: the full command set is identical after curation.
    expect(after).toEqual(before);

    // Visible surface = exactly the core (plus commander's builtin `help`).
    const visible = program.commands
      .filter((c) => !isHidden(c))
      .map((c) => c.name());
    for (const v of visible) {
      if (v === "help") continue;
      expect(
        CORE_COMMANDS,
        `"${v}" is visible but not in the core set`,
      ).toContain(v);
    }
    for (const core of CORE_COMMANDS) {
      expect(visible, `core command "${core}" must stay visible`).toContain(
        core,
      );
    }

    // Everything outside core is hidden, and there are meaningfully many of them
    // (proof the front door was actually calmed, not left wide).
    expect(hidden.length).toBeGreaterThan(20);
    for (const h of hidden) {
      expect(CORE_COMMANDS).not.toContain(h);
    }
  });

  it("hidden commands remain fully registered and invokable", () => {
    const program = buildProgram();
    applyCalmSurface(program);
    // A hidden command (e.g. `eval`) is still found by commander's resolver.
    const evalCmd = program.commands.find((c) => c.name() === "eval");
    expect(evalCmd, "hidden `eval` must still be registered").toBeDefined();
    expect(isHidden(evalCmd!)).toBe(true);
  });
});
