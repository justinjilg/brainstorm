import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { createDefaultToolRegistry, withWorkspace } from "@brainst0rm/tools";
import {
  runAgentLoop,
  buildSystemPrompt,
  SessionManager,
} from "@brainst0rm/core";
import { createLogger } from "@brainst0rm/shared";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { Probe, ProbeResult } from "./types.js";
import { scoreProbe, summarizeChecks } from "./scorer.js";

const log = createLogger("eval");

/**
 * Walk parent directories from start until finding pnpm-workspace.yaml.
 * Returns the directory containing the workspace file.
 * Throws if not found within 15 levels.
 */
export function resolveRepoRoot(start: string): string {
  let current = resolve(start);
  const maxDepth = 15;

  for (let i = 0; i < maxDepth; i++) {
    const workspaceFile = join(current, "pnpm-workspace.yaml");
    if (existsSync(workspaceFile)) {
      return current;
    }

    const parent = dirname(current);
    // Stop if we've reached the filesystem root (parent === current)
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    `Could not find pnpm-workspace.yaml walking up from "${start}" (searched ${maxDepth} levels). Introspection probes must run from inside the brainstorm repo — cd there, or supply RunnerOptions.projectDir.`,
  );
}

// Probes that operate against the real project (everything except sandboxed
// code-correctness runs) get read-only tools. Every current introspection
// probe only verifies grep/file_read/glob usage; leaving write/shell tools
// enabled let a wayward model mutate the actual repo mid-eval (observed:
// a probe agent created stray dirs and cleared node_modules symlinks).
const READ_ONLY_PROBE_TOOLS = ["file_read", "list_dir", "glob", "grep"];

export interface RunnerOptions {
  /** Override the model ID (otherwise uses default routing) */
  modelId?: string;
  /** Project directory for context (default: cwd) */
  projectDir?: string;
  /** Timeout per probe in ms (default: 30000) */
  defaultTimeout?: number;
  /** Override max agentic steps per probe */
  maxSteps?: number;
}

/**
 * Run a single probe through the agentic loop and score the result.
 */
export async function runProbe(
  probe: Probe,
  options: RunnerOptions = {},
): Promise<ProbeResult> {
  const startTime = Date.now();
  const timeout = probe.timeout_ms ?? options.defaultTimeout ?? 30000;

  // Sandbox directory for probe setup files AND for code-correctness runs.
  // Always created — scorer checks it for code_compiles — but the agent's
  // actual workspace depends on probe.workspace.
  //
  // mkdtempSync (rather than join + mkdirSync with a Date.now() suffix)
  // closes the TOCTOU window CodeQL flagged: an attacker on the same
  // machine could otherwise pre-create the predictable path as a
  // symlink to a sensitive directory before our mkdir runs, causing
  // the subsequent writeFileSync to land outside the intended sandbox.
  const sandboxDir = mkdtempSync(
    join(tmpdir(), `brainstorm-eval-${probe.id}-`),
  );

  try {
    // Write setup files. Probe definitions come from arbitrary JSONL
    // (shared SWE-bench mirrors, --probes-dir, user-authored files) so
    // a malicious key like "../../../.ssh/authorized_keys" could write
    // outside the sandbox. Reject any path that resolves outside
    // sandboxDir before touching the filesystem.
    if (probe.setup?.files) {
      const sandboxRoot = resolve(sandboxDir);
      for (const [path, content] of Object.entries(probe.setup.files)) {
        const fullPath = join(sandboxDir, path);
        const resolvedPath = resolve(fullPath);
        if (
          resolvedPath !== sandboxRoot &&
          !resolvedPath.startsWith(sandboxRoot + sep)
        ) {
          throw new Error(
            `Probe ${probe.id}: setup file path escapes sandbox (${path})`,
          );
        }
        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, content, "utf-8");
      }
    }

    // Determine workspace: code-correctness probes operate in sandbox,
    // everything else operates against the brainstorm project so tools
    // like grep/glob/file_read can find real files to introspect.
    //
    // Repo-root discovery applies ONLY to introspection probes without an
    // explicit projectDir: an explicit projectDir is honored as-is, and
    // sandboxed probes never touch the repo — requiring a workspace marker
    // for them would break `brainstorm eval` for installed-CLI users running
    // outside a pnpm workspace.
    const isSandboxProbe =
      probe.workspace === "sandbox" ||
      (!probe.workspace && probe.capability === "code-correctness");
    const configDir =
      options.projectDir ??
      (isSandboxProbe ? process.cwd() : resolveRepoRoot(process.cwd()));
    const agentWorkspace: string = isSandboxProbe ? sandboxDir : configDir;
    const config = loadConfig(configDir);
    const db = getDb();
    const registry = await createProviderRegistry(config);
    const costTracker = new CostTracker(db, config.budget);
    const router = new BrainstormRouter(config, registry, costTracker);
    const tools = createDefaultToolRegistry();
    const sessionManager = new SessionManager(db);
    const session = sessionManager.start(agentWorkspace);
    const { prompt: systemPrompt } = buildSystemPrompt(agentWorkspace);

    sessionManager.addUserMessage(probe.prompt);

    const toolCalls: Array<{ name: string; argsPreview: string }> = [];
    let output = "";
    let steps = 0;

    // Run with timeout — wrap in withWorkspace so path-based tools resolve
    // paths relative to agentWorkspace. Code-correctness probes use sandbox
    // (clean slate for generated files); everything else uses the project
    // root so introspection tools can search real code.
    const runPromise = withWorkspace(agentWorkspace, async () => {
      for await (const event of runAgentLoop(sessionManager.getHistory(), {
        config,
        registry,
        router,
        costTracker,
        tools,
        sessionId: session.id,
        projectPath: agentWorkspace,
        systemPrompt,
        ...(options.modelId && options.modelId !== "default"
          ? { preferredModelId: options.modelId }
          : {}),
        ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
        // Project-workspace probes must not mutate the real project.
        ...(agentWorkspace === sandboxDir
          ? {}
          : { roleToolFilter: { allowedTools: READ_ONLY_PROBE_TOOLS } }),
      })) {
        switch (event.type) {
          case "text-delta":
            output += event.delta;
            break;
          case "tool-call-start":
            toolCalls.push({
              name: event.toolName,
              argsPreview: JSON.stringify(event.args).slice(0, 100),
            });
            steps++;
            break;
          case "error":
            throw event.error;
        }
      }
    });

    // Race against timeout. Caller-owns the timer so we can clear it after
    // the race — otherwise the abort listener stays attached and fires on an
    // already-resolved promise for every probe that finishes under the
    // timeout, calling reject() on nothing and retaining the closure.
    const probeTimeoutController = new AbortController();
    const probeTimeoutTimer = setTimeout(
      () => probeTimeoutController.abort(),
      timeout,
    );
    try {
      await Promise.race([
        runPromise,
        new Promise((_, reject) => {
          probeTimeoutController.signal.addEventListener(
            "abort",
            () => reject(new Error(`Probe timed out after ${timeout}ms`)),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(probeTimeoutTimer);
    }

    const durationMs = Date.now() - startTime;
    const cost = costTracker.getSessionCost();

    // Score the result. `passed` is CORRECTNESS-first (right artifact/answer);
    // efficiency (step budget) is reported separately so a correct-but-slow run
    // is no longer counted as a failure — the eval-reliability fix.
    const checks = scoreProbe(probe, { output, toolCalls, steps, sandboxDir });
    const { correct, efficient } = summarizeChecks(checks);

    return {
      probeId: probe.id,
      capability: probe.capability,
      passed: correct,
      efficient,
      checks,
      modelId: options.modelId ?? "default",
      cost,
      steps,
      toolCalls,
      output: output.slice(0, 2000), // Truncate for storage
      durationMs,
    };
  } catch (error: any) {
    return {
      probeId: probe.id,
      capability: probe.capability,
      passed: false,
      checks: [],
      modelId: options.modelId ?? "default",
      cost: 0,
      steps: 0,
      toolCalls: [],
      output: "",
      durationMs: Date.now() - startTime,
      error: String(error?.message ?? error),
    };
  } finally {
    // Clean up sandbox
    try {
      if (existsSync(sandboxDir)) rmSync(sandboxDir, { recursive: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

/**
 * Run all probes and return results.
 */
export async function runAllProbes(
  probes: Probe[],
  options: RunnerOptions = {},
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const probe of probes) {
    log.info(
      { probeId: probe.id, capability: probe.capability },
      "Running probe",
    );
    const result = await runProbe(probe, options);
    results.push(result);
    log.info(
      {
        probeId: probe.id,
        passed: result.passed,
        cost: result.cost,
        durationMs: result.durationMs,
      },
      result.passed ? "Probe passed" : "Probe failed",
    );
  }

  return results;
}
