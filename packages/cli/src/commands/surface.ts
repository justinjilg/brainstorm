/**
 * The calm CLI surface (Phase 4: "The Substrate" charter).
 *
 * The split relocated ~55 top-level verbs into cohesive modules but the front
 * door still LISTED all of them — reorganized clutter, not a calm window. This
 * curates the default `brainstorm --help` to a small core of daily + headless
 * commands. Every other command stays FULLY functional and parity-tested — it is
 * only hidden from the top-level listing, and remains discoverable via
 * `brainstorm <command> --help`. Nothing is removed; the surface is calmed.
 */
import { Command } from "commander";

/** The commands shown on the calm front door: the operator's daily surface plus
 * the headless/automation substrate. Keep this list SMALL and deliberate. */
export const CORE_COMMANDS: readonly string[] = [
  // discovery
  "commands",
  // daily operator
  "chat",
  "run",
  "models",
  "budget",
  "config",
  "doctor",
  "memory",
  "vault",
  "router",
  // headless substrate
  "ipc",
  "serve",
  "mcp",
];

/**
 * Register `brainstorm commands` — the discovery reveal for the calm surface.
 * By default it lists the core; `--all` lists every registered command,
 * including the hidden advanced set, so power users don't have to know names.
 */
const CORE = new Set<string>([...CORE_COMMANDS, "help"]);

/** True for a top-level command shown on the calm front door. */
export function isCoreCommand(name: string): boolean {
  return CORE.has(name);
}

/**
 * Register `brainstorm commands` — the discovery reveal for the calm surface.
 * By default it lists the core; `--all` lists every registered command,
 * including the hidden advanced set, so power users don't have to know names.
 */
export function registerCommandsIndex(program: Command): void {
  program
    .command("commands")
    .description("List available commands (use --all to include advanced)")
    .option("--all", "Include the advanced (non-core) commands")
    .action((opts: { all?: boolean }) => {
      const rows = program.commands
        .filter((c) => c.name() !== "commands")
        .filter((c) => opts.all || isCoreCommand(c.name()))
        .map((c) => ({ name: c.name(), desc: c.description() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const heading = opts.all
        ? "All commands"
        : "Core commands (--all for more)";
      console.log(`\n  ${heading}\n`);
      for (const r of rows) console.log(`    ${r.name.padEnd(16)} ${r.desc}`);
      console.log();
    });
}

/**
 * Calm the top-level help to the core set — via commander's PUBLIC
 * `configureHelp({ visibleCommands })`, not by poking a private `_hidden` field.
 * Only the ROOT program's listing is curated; every command stays fully
 * registered and invokable, and each command's own `--help` is untouched.
 * Returns the advanced (hidden-from-listing) names, for the surface charter test.
 */
export function applyCalmSurface(program: Command): string[] {
  const advanced = program.commands
    .map((c) => c.name())
    .filter((n) => !isCoreCommand(n));
  program.configureHelp({
    visibleCommands(cmd) {
      // Curate only the root program's command listing; subcommand help (e.g.
      // `router --help`) keeps its full default listing. No command is hidden
      // in this build, so `cmd.commands` is the full visible set to filter.
      return cmd === program
        ? cmd.commands.filter((c) => isCoreCommand(c.name()))
        : cmd.commands;
    },
  });
  program.addHelpText(
    "after",
    "\n  Showing core commands. Run `brainstorm commands --all` to list every\n  advanced command (all remain fully available via `brainstorm <cmd> --help`).\n",
  );
  return advanced;
}
