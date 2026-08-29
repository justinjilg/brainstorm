/**
 * brainstorm CLI entry — assembles the program from commands/* modules.
 *
 * The former 9,371-line god-file was split (Phase 1 of the UX reimagining): all
 * subcommand registrations now live in commands/cmd-*.ts as register*(program)
 * functions, shared helpers in commands/_context.ts. This file only builds the
 * program, wires the modules, and owns the process lifecycle (run()).
 */
import { Command } from "commander";
import { initSentry, captureError, flushSentry } from "@brainst0rm/shared";
import { closeDb } from "@brainst0rm/db";
import { teardownDockerSandbox, getSandboxPool } from "@brainst0rm/tools";
import { CLI_VERSION } from "../commands/_context.js";
import { registerAllCommands } from "../commands/registry.js";
import {
  applyCalmSurface,
  registerCommandsIndex,
} from "../commands/surface.js";

const program = new Command();
program
  .name("brainstorm")
  .description("AI coding assistant with intelligent model routing")
  .version(CLI_VERSION);

// Register every command module from the single shared registrar list (the same
// list the parity/surface charter tests build from — one source of truth).
registerAllCommands(program);

// A `commands` command reveals the full inventory (`--all` includes the hidden
// advanced set), so power users don't have to already know the names.
registerCommandsIndex(program);

// Calm the front door: show a small core in `--help`; keep everything else
// registered, functional, and discoverable via `brainstorm commands --all`.
applyCalmSurface(program);

export function run() {
  // Initialize Sentry — no-ops if SENTRY_DSN is not set
  initSentry({ release: process.env.npm_package_version });

  // Graceful shutdown: stop Docker sandbox, close DB, flush Sentry
  const cleanup = () => {
    try {
      // Discard (not release) the live sandbox directly — drain() below
      // stops it anyway, so running the pool's hygiene-reset exec first
      // is a wasted round-trip that can also stall shutdown if the
      // container/daemon is wedged (see teardownDockerSandbox() doc).
      teardownDockerSandbox();
      // Full teardown on process exit — release() alone would just park
      // the container as idle-warm, which we don't want to leak past
      // the CLI process lifetime.
      getSandboxPool().drain();
    } catch {
      // Best effort — container may already be stopped
    }
    try {
      closeDb();
    } catch {
      // Best effort — DB may already be closed
    }
    flushSentry(1500).catch(() => {});
  };

  // Catch unhandled errors and report to Sentry AND print to stderr.
  //
  // Without the stderr print, a thrown exception during startup causes the
  // CLI to exit silently with code 1 and zero output — which is exactly
  // what happened with the duplicate `doctor` command registration in this
  // session (see commit c6c7445). Every brainstorm invocation died silently
  // for an unknown duration because the handler ate the commander error.
  //
  // The fix is trivial: print the error message + stack to stderr before
  // running cleanup. Sentry capture stays (no-op without DSN). Developers
  // now get "Error: cannot add command 'doctor' as already have command
  // 'doctor' ..." instead of bash-level "exit=1".
  process.on("uncaughtException", (err) => {
    process.stderr.write(`\n  ⚠ Uncaught exception: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    captureError(err, { source: "uncaughtException" });
    cleanup();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`\n  ⚠ Unhandled promise rejection: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    captureError(err, { source: "unhandledRejection" });
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("exit", () => {
    cleanup();
  });

  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  } else {
    program.parse();
  }
}

run();
