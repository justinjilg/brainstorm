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
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Probe, ProbeResult } from "./types.js";
import { scoreProbe } from "./scorer.js";

const log = createLogger("eval");

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
  const sandboxDir = join(
    tmpdir(),
    `brainstorm-eval-${probe.id}-${Date.now()}`,
  );
  mkdirSync(sandboxDir, { recursive: true });

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
    const configDir = options.projectDir ?? process.cwd();
    const agentWorkspace: string =
      probe.workspace === "sandbox" ||
      (!probe.workspace && probe.capability === "code-correctness")
        ? sandboxDir
        : configDir;
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

    // Score the result
    const checks = scoreProbe(probe, { output, toolCalls, steps, sandboxDir });

    return {
      probeId: probe.id,
      capability: probe.capability,
      passed: checks.every((c) => c.passed),
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
