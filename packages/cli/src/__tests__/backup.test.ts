/**
 * Tests for `brainstorm backup` subcommand registration.
 *
 * The actual god-mode POST is mocked at fetch boundary — these tests
 * just verify the command tree wires up cleanly and the option parser
 * rejects malformed invocations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import {
  registerBackupCommand,
  parseRetentionDays,
} from "../commands/backup.js";

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

  it("list-schedules takes an optional --tenant via shared options", () => {
    const backup = program.commands.find((c) => c.name() === "backup")!;
    const listSchedules = backup.commands.find(
      (c) => c.name() === "list-schedules",
    )!;
    const tenantOpt = listSchedules.options.find((o) => o.long === "--tenant");
    expect(tenantOpt).toBeDefined();
    expect(tenantOpt!.mandatory).toBe(false);
  });
});

describe("parseRetentionDays", () => {
  it("returns undefined for empty input", () => {
    expect(parseRetentionDays(undefined)).toBeUndefined();
    expect(parseRetentionDays("")).toBeUndefined();
  });

  it("parses '<N>d' into a day count", () => {
    expect(parseRetentionDays("30d")).toBe(30);
    expect(parseRetentionDays("90d")).toBe(90);
    expect(parseRetentionDays("365d")).toBe(365);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseRetentionDays(" 7d ")).toBe(7);
  });

  it("throws on malformed input", () => {
    expect(() => parseRetentionDays("30")).toThrow();
    expect(() => parseRetentionDays("1 month")).toThrow();
    expect(() => parseRetentionDays("30days")).toThrow();
  });
});
