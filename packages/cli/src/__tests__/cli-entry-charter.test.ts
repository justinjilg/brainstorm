/**
 * CLI "Substrate" charter guardrail (Phase 4 of the UX reimagining).
 *
 * The former bin/brainstorm.ts was a 9,371-line god-file registering ~80
 * subcommands inline. It was split into commands/cmd-*.ts register functions.
 * This test keeps the entry file thin — it may only build the program, wire the
 * command modules, and own the process lifecycle. A regression that starts
 * dumping command bodies back into the entry trips this immediately.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "bin", "brainstorm.ts");

describe("CLI entry charter", () => {
  const text = readFileSync(entry, "utf-8");

  it("keeps the entry file thin (the god-file stays dead)", () => {
    const lines = text.split("\n").length;
    expect(lines).toBeLessThan(200);
  });

  it("registers commands via the shared registrar list, not inline .command() bodies", () => {
    // The entry wires the modules through the single shared list; it must not
    // itself define subcommands with `.command(...)` (those live in commands/*).
    expect(text).toMatch(/registerAllCommands\(program\)/);
    expect(text).not.toMatch(/\.command\(/);
  });
});
