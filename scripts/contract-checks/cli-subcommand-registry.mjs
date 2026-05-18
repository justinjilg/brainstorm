/**
 * CLI subcommand registry gate.
 *
 * The brainstorm CLI exposes 99 subcommand verbs across 12 command
 * groups (router, agent, peer, workflow, vault, projects, schedule,
 * plan, orchestrate, codebase, platform, plus top-level program).
 * Adding a new verb is too easy — a contributor writes a
 * Commander .command() call somewhere in
 * `packages/cli/src/bin/brainstorm.ts` and the verb ships without
 * anyone deciding it should.
 *
 * The Stage-3 review caught that the original gate keyed verbs by
 * leaf name only, which deduped 99 source declarations to 77
 * registry entries — `vault delete`, `peer kick`, etc. could be
 * added under existing groups with zero gate friction because
 * `delete`/`list`/etc. were already registered (against different
 * groups). Stage-3.5 keys every entry by `<group>:<verb>` so
 * subcommand drift inside a group is now visible.
 *
 * Extraction logic:
 *   Each .command(...) call in source has a receiver — either the
 *   top-level `program`, or a `<group>Cmd` variable defined earlier
 *   (e.g. `routerCmd`, `vaultCmd`). The receiver appears on the line
 *   before the chained `.command(...)` due to multi-line builder
 *   style. We walk every match and pair each verb with its
 *   immediate receiver identifier.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

// Matches `<receiver>` (optionally on its own line) followed by
// `.command("verb...")`. Captures the receiver and verb separately.
const COMMAND_RE =
  /(\w+)\s*\n?\s*\.command\(\s*["']([a-zA-Z0-9:_<>\-\[\]]+(?:\s+[a-zA-Z0-9:_<>\[\]]+)*?)["']/g;

export async function check({ repoRoot }) {
  const issues = [];

  const cliPath = path.join(repoRoot, "packages/cli/src/bin/brainstorm.ts");
  const registryPath = path.join(
    repoRoot,
    "scripts/contract-checks/cli-subcommand-registry.json",
  );

  let cliSrc;
  try {
    cliSrc = readFileSync(cliPath, "utf8");
  } catch (err) {
    return {
      name: "cli-subcommand-registry",
      ok: false,
      issues: [
        `cannot read CLI source at ${cliPath}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    return {
      name: "cli-subcommand-registry",
      ok: false,
      issues: [
        `cannot read registry at ${registryPath}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // Build (group, verb) tuples from source. Skip non-Commander
  // callers — only `program` and `<x>Cmd` receivers count.
  const sourceEntries = new Set();
  for (const m of cliSrc.matchAll(COMMAND_RE)) {
    const receiver = m[1];
    const verb = m[2].split(/\s+/)[0];
    if (receiver === "program" || receiver.endsWith("Cmd")) {
      sourceEntries.add(`${receiver}:${verb}`);
    }
  }

  const registeredEntries = new Set(Object.keys(registry.subcommands ?? {}));
  const knownCategories = new Set(Object.keys(registry._categories ?? {}));

  for (const entry of sourceEntries) {
    if (!registeredEntries.has(entry)) {
      issues.push(
        `CLI source declares "${entry}" but it's not in the registry. ` +
          `Add it to scripts/contract-checks/cli-subcommand-registry.json with a category.`,
      );
    }
  }

  for (const entry of registeredEntries) {
    if (!sourceEntries.has(entry)) {
      issues.push(
        `registry lists "${entry}" but no source declaration matches. ` +
          `Remove the registry entry or restore the verb.`,
      );
    }
  }

  for (const [entry, category] of Object.entries(registry.subcommands ?? {})) {
    if (!knownCategories.has(category)) {
      issues.push(
        `"${entry}" categorised as "${category}" but no such category is documented in _categories. ` +
          `Either pick a known category or document this new one.`,
      );
    }
  }

  return {
    name: "cli-subcommand-registry",
    ok: issues.length === 0,
    issues,
    note: `${sourceEntries.size} source entries · ${registeredEntries.size} registered · ${knownCategories.size} categories`,
  };
}
