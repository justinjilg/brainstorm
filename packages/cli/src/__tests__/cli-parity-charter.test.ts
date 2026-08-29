/**
 * CLI command-parity + registration charter (Phase 4 hardening).
 *
 * The god-file split moved ~80 subcommands into commands/cmd-* register modules.
 * A DX reviewer rightly wants command parity proven by an EXECUTABLE map, not by
 * a "behavior unchanged" narrative. This test builds the real program from the
 * register modules and pins it:
 *   1. Every domain module registers without commander throwing — commander
 *      itself rejects a DUPLICATE top-level command, so this is the uniqueness
 *      guarantee (the old god-file's doubled models/budget/config would fail here).
 *   2. The set of top-level commands is FROZEN — a silently dropped or smuggled
 *      command breaks this test, so parity can't regress unnoticed.
 */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { COMMAND_REGISTRARS } from "../commands/registry.js";

// One shared registrar list — the same one the entry and the surface charter use.
const REGISTRARS = COMMAND_REGISTRARS;

/** The frozen top-level command surface. A change here must be deliberate. */
const EXPECTED_COMMANDS = [
  "a2a",
  "agent",
  "analyze",
  "audit",
  "backup",
  "budget",
  "chat",
  "ci-gen",
  "cloud",
  "codebase",
  "config",
  "dispatch",
  "docgen",
  "doctor",
  "ecosystem",
  "eval",
  "eval-swe-bench",
  "evidence",
  "findings",
  "harness",
  "ingest",
  "init",
  "intelligence",
  "introspect",
  "ipc",
  "login",
  "loop",
  "mcp",
  "memory",
  "metrics",
  "models",
  "onboard",
  "orchestrate",
  "peer",
  "plan",
  "platform",
  "probe",
  "projects",
  "queue",
  "route",
  "router",
  "run",
  "schedule",
  "search",
  "serve",
  "sessions",
  "setup",
  "setup-infra",
  "share",
  "spawn",
  "start",
  "storm",
  "sync",
  "trace",
  "vault",
  "workflow",
].sort();

describe("CLI command parity charter", () => {
  it("builds the whole program from register modules with no duplicate command", () => {
    const program = new Command();
    // commander throws "cannot add command X as already have command X" on a
    // duplicate — so this call site IS the uniqueness assertion.
    expect(() => {
      for (const register of REGISTRARS) register(program);
    }).not.toThrow();
  });

  it("freezes the top-level command surface (parity map)", () => {
    const program = new Command();
    for (const register of REGISTRARS) register(program);
    const names = program.commands.map((c) => c.name()).sort();
    // Every expected command is present (nothing silently dropped)…
    for (const cmd of EXPECTED_COMMANDS) {
      expect(names, `command "${cmd}" went missing after the split`).toContain(
        cmd,
      );
    }
    // …and nothing was smuggled in outside the frozen surface.
    for (const name of names) {
      expect(
        EXPECTED_COMMANDS,
        `unexpected new top-level command "${name}"`,
      ).toContain(name);
    }
  });

  it("registers exactly the 14 domain modules", () => {
    expect(REGISTRARS).toHaveLength(14);
  });

  // Parity down to the subcommand tree — a top-level-names-only freeze would let
  // a subcommand quietly drift inside a registrar. Every group's children are pinned.
  const EXPECTED_SUBTREES: Record<string, string[]> = {
    router: ["audit", "budget", "config", "keys", "memory", "models", "status"],
    agent: ["create", "delete", "list", "show"],
    peer: ["health", "list", "messages", "send", "set-summary"],
    workflow: ["list", "run"],
    vault: [
      "add",
      "bootstrap",
      "get",
      "init",
      "list",
      "lock",
      "remove",
      "rotate",
      "status",
    ],
    projects: ["import", "list", "register", "show", "switch"],
    schedule: ["add", "delete", "history", "list", "pause", "resume", "run"],
    plan: ["execute", "parse"],
    orchestrate: ["history", "parallel", "pipeline", "run", "status"],
    codebase: ["audit"],
    audit: ["report"],
    platform: ["init", "validate", "verify"],
  };

  it("freezes each group's subcommand tree", () => {
    const program = new Command();
    for (const register of REGISTRARS) register(program);
    for (const [group, expected] of Object.entries(EXPECTED_SUBTREES)) {
      const cmd = program.commands.find((c) => c.name() === group);
      expect(cmd, `group "${group}" missing`).toBeDefined();
      const subs = cmd!.commands.map((c) => c.name()).sort();
      expect(subs, `subcommand drift under "${group}"`).toEqual(
        [...expected].sort(),
      );
    }
  });
});
