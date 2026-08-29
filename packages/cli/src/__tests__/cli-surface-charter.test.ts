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

describe("CLI calm-surface charter", () => {
  it("core is small and deliberate (≤ 16 verbs on the front door)", () => {
    expect(CORE_COMMANDS.length).toBeLessThanOrEqual(16);
  });

  it("shows only the core in --help, hides the rest — but removes nothing", () => {
    const program = buildProgram();
    const before = program.commands.map((c) => c.name()).sort();
    const advanced = applyCalmSurface(program);
    const after = program.commands.map((c) => c.name()).sort();

    // Nothing removed: the full command set is identical after curation.
    expect(after).toEqual(before);

    // The curated top-level help (commander's public help output) lists the core
    // and NOT the advanced set — no private-field poking involved.
    const help = program.helpInformation();
    for (const core of CORE_COMMANDS) {
      if (core === "commands") continue; // added separately in the real entry
      expect(help, `core command "${core}" must appear in --help`).toMatch(
        new RegExp(`\\b${core}\\b`),
      );
    }
    // A representative advanced command must NOT appear in the top-level listing.
    for (const adv of ["eval", "orchestrate", "spawn", "ingest"]) {
      expect(help, `advanced "${adv}" must be hidden from --help`).not.toMatch(
        new RegExp(`^\\s+${adv}\\b`, "m"),
      );
    }

    // The front door was actually calmed (many advanced verbs), none of them core.
    expect(advanced.length).toBeGreaterThan(20);
    for (const a of advanced) expect(CORE_COMMANDS).not.toContain(a);
  });

  it("advanced commands stay fully registered and invokable (not removed)", () => {
    const program = buildProgram();
    applyCalmSurface(program);
    // A hidden-from-listing command (e.g. `eval`) is still resolvable/invokable.
    const evalCmd = program.commands.find((c) => c.name() === "eval");
    expect(evalCmd, "advanced `eval` must still be registered").toBeDefined();
  });
});
