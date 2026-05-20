/**
 * Tests for `brainstorm backup` subcommand registration.
 *
 * The actual god-mode POST is mocked at fetch boundary — these tests
 * just verify the command tree wires up cleanly and the option parser
 * rejects malformed invocations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerBackupCommand } from "../commands/backup.js";

describe("brainstorm backup", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride(); // throw instead of process.exit
    registerBackupCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the backup command with 6 subcommands", () => {
    const backup = program.commands.find((c) => c.name() === "backup");
    expect(backup).toBeDefined();
    const subcommandNames = backup!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual([
      "create-schedule",
      "list-drills",
      "list-schedules",
      "purge",
      "run-now",
      "run-restore-drill",
    ]);
  });

  it("create-schedule requires --name, --cadence, --target", () => {
    expect(() =>
      program.parse(["backup", "create-schedule"], { from: "user" }),
    ).toThrow();
  });

  it("run-now requires --schedule-id", () => {
    expect(() =>
      program.parse(["backup", "run-now"], { from: "user" }),
    ).toThrow();
  });

  it("purge requires --confirm", () => {
    expect(() =>
      program.parse(["backup", "purge", "--schedule-id", "abc"], {
        from: "user",
      }),
    ).toThrow();
  });

  it("list-schedules takes an optional --tenant", () => {
    const backup = program.commands.find((c) => c.name() === "backup")!;
    const listSchedules = backup.commands.find(
      (c) => c.name() === "list-schedules",
    )!;
    const tenantOpt = listSchedules.options.find((o) => o.long === "--tenant");
    expect(tenantOpt).toBeDefined();
    // Optional flag with `--tenant <id>` (angle brackets without `--required`)
    // means the option itself is not required; verify by mandatory flag.
    expect(tenantOpt!.mandatory).toBe(false);
  });
});
