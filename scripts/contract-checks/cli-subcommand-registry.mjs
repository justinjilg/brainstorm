/**
 * CLI subcommand registry gate.
 *
 * The brainstorm CLI exposes ~77 subcommand verbs across 11 command
 * groups (router, agent, peer, workflow, vault, projects, schedule,
 * plan, orchestrate, codebase, platform). Adding a new verb is too
 * easy — a contributor writes a Commander .command() call somewhere
 * in `packages/cli/src/bin/brainstorm.ts` and the verb ships without
 * anyone deciding it should.
 *
 * This gate enforces deliberate addition: every command verb extracted
 * from the CLI source must appear in `cli-subcommand-registry.json`,
 * categorised. The categories aren't load-bearing today — they're a
 * forcing function that the author had to think about WHERE the
 * command fits.
 *
 * Pattern lifted from BrainstormRouter's `_no-inline-routes.test.ts`
 * plus the Stage-1 `BUILTIN_TOOL_METADATA` table: "discover from
 * source, lock with allowlist, fail CI on additions."
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

const COMMAND_RE = /\.command\(\s*["']([a-zA-Z0-9:_<>\-\[\]]+(?:\s+[a-zA-Z0-9:_<>\[\]]+)*?)["']/g;

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

  const sourceVerbs = new Set();
  for (const m of cliSrc.matchAll(COMMAND_RE)) {
    const verb = m[1].split(/\s+/)[0];
    sourceVerbs.add(verb);
  }

  const registeredVerbs = new Set(Object.keys(registry.subcommands ?? {}));
  const knownCategories = new Set(Object.keys(registry._categories ?? {}));

  for (const verb of sourceVerbs) {
    if (!registeredVerbs.has(verb)) {
      issues.push(
        `CLI source declares verb "${verb}" but it's not in the registry. ` +
          `Add it to scripts/contract-checks/cli-subcommand-registry.json with a category.`,
      );
    }
  }

  for (const verb of registeredVerbs) {
    if (!sourceVerbs.has(verb)) {
      issues.push(
        `registry lists verb "${verb}" but no source declaration matches. ` +
          `Remove the registry entry or restore the verb.`,
      );
    }
  }

  for (const [verb, category] of Object.entries(registry.subcommands ?? {})) {
    if (!knownCategories.has(category)) {
      issues.push(
        `verb "${verb}" categorised as "${category}" but no such category is documented in _categories. ` +
          `Either pick a known category or document this new one.`,
      );
    }
  }

  return {
    name: "cli-subcommand-registry",
    ok: issues.length === 0,
    issues,
    note: `${sourceVerbs.size} source verbs · ${registeredVerbs.size} registered · ${knownCategories.size} categories`,
  };
}
