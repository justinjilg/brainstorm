import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import {
  createDefaultToolRegistry,
  withSession,
  withWorkspace,
} from "@brainst0rm/tools";
import { runAgentLoop, buildSystemPrompt, SessionManager } from "@brainst0rm/core";
import { createLogger } from "@brainst0rm/shared";
import type { RunOutcome } from "@brainst0rm/shared";
import type { E2ETask, E2ETrialResult, TrialStatus } from "./types.js";
import {
  createDockerCommandExecutor,
  localCommandExecutor,
  snapshotSandbox,
  verifyE2EArtifact,
  type E2ECommandExecutor,
} from "./verifier.js";
import { buildE2EScorecard } from "./scorecard.js";

const log = createLogger("eval-e2e");

/** Does a usable Docker daemon exist? Cached — probing spawns a process. */
let _dockerProbe: boolean | undefined;
export function dockerAvailable(): boolean {
  if (_dockerProbe !== undefined) return _dockerProbe;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    _dockerProbe = true;
  } catch {
    _dockerProbe = false;
  }
  return _dockerProbe;
}

/** Test hook: force the cached Docker-availability probe. `undefined` re-probes. */
export function __setDockerProbe(value: boolean | undefined): void {
  _dockerProbe = value;
}

export interface ResolvedExecutor {
  executor: E2ECommandExecutor;
  /** True when commands run inside a container (read-only host, no network). */
  jailed: boolean;
}

/**
 * Pick the command executor for verification. Prefers the Docker-jailed
 * executor — verification runs `node --test`, which executes model-authored
 * code, so a read-only-host / network-none container is the correct isolation.
 * Falls back to the local (process-group-isolated but NOT filesystem-jailed)
 * executor when Docker is unavailable.
 */
export function resolveDefaultExecutor(): ResolvedExecutor {
  return dockerAvailable()
    ? { executor: createDockerCommandExecutor(), jailed: true }
    : { executor: localCommandExecutor, jailed: false };
}

export interface E2ERunnerOptions {
  /** Model to pin (strict — no fallback, for auditable attribution). */
  modelId: string;
  /** Override the verification executor. Default: {@link resolveDefaultExecutor}. */
  executor?: E2ECommandExecutor;
  /**
   * Refuse to run a task unless commands execute inside the Docker jail. Defaults
   * to true for the `adversarial` domain (its verification runs deliberately
   * hostile artifacts) and false otherwise.
   */
  requireJail?: boolean;
  /** Directory whose config/providers to load. Default: cwd. */
  configDir?: string;
  /** Trial index for repeated runs (recorded on the result). */
  trial?: number;
}

/** Materialize a task's setup fixtures into the sandbox, rejecting escapes. */
export function writeSetupFiles(
  sandbox: string,
  files: Record<string, string>,
): void {
  const root = resolve(sandbox);
  for (const [path, content] of Object.entries(files)) {
    if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
      throw new Error(`setup path escapes sandbox: ${path}`);
    }
    const absolute = resolve(root, path);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`setup path escapes sandbox: ${path}`);
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

export interface LoopObservation {
  outcome: RunOutcome | null;
  hasFinalResponse: boolean;
  steps: number;
  aborted: boolean;
  error?: Error;
}

/**
 * Run one end-to-end task through the real Brainstorm agent loop, then verify
 * the sandbox deterministically. Abort-safe: the task's timeout aborts the loop
 * itself (the signal is threaded into runAgentLoop), not just a lost race, so no
 * model keeps burning tokens after the deadline.
 */
export async function runE2ETrial(
  task: E2ETask,
  options: E2ERunnerOptions,
): Promise<E2ETrialResult> {
  const startedAt = Date.now();
  const trial = options.trial ?? 0;
  const requireJail = options.requireJail ?? task.domain === "adversarial";

  const resolved = options.executor
    ? { executor: options.executor, jailed: false }
    : resolveDefaultExecutor();
  if (requireJail && !options.executor && !resolved.jailed) {
    return errorResult(
      task,
      options.modelId,
      trial,
      startedAt,
      `task '${task.id}' requires a Docker jail for verification but Docker is unavailable`,
    );
  }

  const sandbox = mkdtempSync(join(tmpdir(), `brainstorm-e2e-${task.id}-`));
  try {
    if (task.setup?.files) writeSetupFiles(sandbox, task.setup.files);

    // Baseline BEFORE the model runs — noMutation correctness depends on it.
    const beforeSnapshot = snapshotSandbox(sandbox);

    const obs = await driveLoop(task, sandbox, options);

    const verification = await verifyE2EArtifact(task, sandbox, {
      executor: resolved.executor,
      beforeSnapshot,
    });

    const durationMs = Date.now() - startedAt;
    const status = trialStatus(obs);
    const correctness = verification.passed ? 1 : 0;
    // A run that CLAIMED success but did not verify is a silent success — the
    // single most important thing the contract exists to catch.
    const silentFailure = status === "succeeded" && !verification.passed;
    const noMutationCheck = verification.checks.find(
      (c) => c.id === "workspace:no-mutation",
    );
    const stateCorruption = noMutationCheck?.passed === false;

    return {
      taskId: task.id,
      modelId: options.modelId,
      trial,
      status,
      correctness,
      // quality is a separate versioned-rubric pass; left undefined until a
      // grader is wired so the scorecard doesn't count ungraded tasks.
      quality: undefined,
      efficiency: efficiencyScore(task, obs, durationMs),
      resilience: resilienceScore(obs),
      governance: governanceScore(obs, stateCorruption),
      durationMs,
      costUsd: obs.outcome?.costUsd ?? 0,
      attempts: obs.outcome?.attempts?.length ?? 1,
      recovered: (obs.outcome?.recovery?.length ?? 0) > 0,
      silentFailure,
      stateCorruption,
      artifactPaths: verification.artifacts.map((a) => a.path),
      ...(obs.error ? { error: obs.error.message } : {}),
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function driveLoop(
  task: E2ETask,
  sandbox: string,
  options: E2ERunnerOptions,
): Promise<LoopObservation> {
  const configDir = options.configDir ?? process.cwd();
  const config = loadConfig(configDir);
  const db = getDb();
  const registry = await createProviderRegistry(config);
  const costTracker = new CostTracker(db, config.budget);
  const router = new BrainstormRouter(config, registry, costTracker);
  const tools = createDefaultToolRegistry();
  const session = new SessionManager(db).start(sandbox);
  const { prompt: systemPrompt } = buildSystemPrompt(sandbox);

  // Abort-safe timeout: abort the LOOP (via signal), not just the race.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.timeoutMs);

  const obs: LoopObservation = {
    outcome: null,
    hasFinalResponse: false,
    steps: 0,
    aborted: false,
  };
  try {
    await withWorkspace(sandbox, () =>
      withSession(session.id, async () => {
        for await (const event of runAgentLoop(
          [{ role: "user" as const, content: task.prompt }],
          {
            config,
            registry,
            router,
            costTracker,
            tools,
            sessionId: session.id,
            projectPath: sandbox,
            systemPrompt,
            preferredModelId: options.modelId,
            allowModelFallback: false, // strict, auditable model pin
            maxSteps: task.maxSteps,
            signal: controller.signal,
            trajectoryEnabled: false,
          } as Parameters<typeof runAgentLoop>[1],
        )) {
          switch (event.type) {
            case "tool-call-start":
              obs.steps++;
              break;
            case "text-delta":
              if (event.delta.trim().length > 0) obs.hasFinalResponse = true;
              break;
            case "interrupted":
              obs.aborted = true;
              break;
            case "done":
              obs.outcome = event.outcome ?? null;
              if (event.outcome?.hasFinalResponse) obs.hasFinalResponse = true;
              break;
            case "error":
              obs.error = event.error;
              break;
          }
        }
      }),
    );
  } catch (error) {
    obs.error = error as Error;
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) obs.aborted = true;
  return obs;
}

function trialStatus(obs: LoopObservation): TrialStatus {
  if (obs.aborted) return "aborted";
  if (obs.error) return "errored";
  return obs.outcome?.status === "succeeded" ? "succeeded" : "failed";
}

/**
 * Efficiency: did the work stay inside the declared step + time budgets?
 * Independent of correctness — a correct-but-slow run still scores correctness
 * 1.0; this axis alone reflects the budget overrun. 1.0 within budget, decaying
 * linearly to 0 at 2× either budget.
 */
export function efficiencyScore(
  task: E2ETask,
  obs: LoopObservation,
  durationMs: number,
): number {
  const stepRatio = task.maxSteps > 0 ? obs.steps / task.maxSteps : 0;
  const timeRatio = task.timeoutMs > 0 ? durationMs / task.timeoutMs : 0;
  const worst = Math.max(stepRatio, timeRatio);
  if (worst <= 1) return 1;
  return Math.max(0, 1 - (worst - 1));
}

/**
 * Resilience: did the run reach a USABLE terminal state? A run that produced a
 * final response (possibly via recovery) is resilient; one that aborted,
 * errored, or ended empty is not. Recovery that still lands a usable answer
 * scores full resilience — recovering IS the resilient behavior.
 */
export function resilienceScore(obs: LoopObservation): number {
  if (obs.aborted || obs.error) return 0;
  return obs.hasFinalResponse ? 1 : 0;
}

/**
 * Governance: workspace isolation held. Starts at 1.0; a noMutation violation
 * (the model corrupted state it was told to leave alone) drops it to 0. Further
 * signals (permissions, approvals, secret handling) fold in here as they're
 * wired.
 */
export function governanceScore(
  obs: LoopObservation,
  stateCorruption: boolean,
): number {
  if (stateCorruption) return 0;
  return 1;
}

function errorResult(
  task: E2ETask,
  modelId: string,
  trial: number,
  startedAt: number,
  message: string,
): E2ETrialResult {
  return {
    taskId: task.id,
    modelId,
    trial,
    status: "errored",
    correctness: 0,
    efficiency: 0,
    resilience: 0,
    governance: 0,
    durationMs: Date.now() - startedAt,
    costUsd: 0,
    attempts: 0,
    recovered: false,
    silentFailure: false,
    stateCorruption: false,
    artifactPaths: [],
    error: message,
  };
}

export interface E2ESuiteRunOptions extends E2ERunnerOptions {
  /** Repeated trials per task (default 1). */
  trialsPerTask?: number;
  /** Suite id for the scorecard (default "kernel-e2e-v1"). */
  suiteId?: string;
}

/**
 * Run every task in the suite `trialsPerTask` times and fold the results into a
 * scorecard. The executor is resolved ONCE and reused across all trials.
 */
export async function runE2ESuite(
  tasks: E2ETask[],
  options: E2ESuiteRunOptions,
) {
  const trialsPerTask = options.trialsPerTask ?? 1;
  // Warn once when there is no user-supplied executor AND no Docker jail — but
  // do NOT inject a resolved executor here: each trial must resolve its own so
  // `requireJail` (adversarial tasks) is still enforced per task. dockerAvailable
  // is cached, so per-trial resolution is cheap.
  if (!options.executor && !resolveDefaultExecutor().jailed) {
    log.warn(
      "Docker unavailable — non-adversarial verification runs UNJAILED (local executor); adversarial tasks will error unless requireJail is set false.",
    );
  }

  const results: E2ETrialResult[] = [];
  for (const task of tasks) {
    for (let trial = 0; trial < trialsPerTask; trial++) {
      results.push(await runE2ETrial(task, { ...options, trial }));
    }
  }
  return buildE2EScorecard(
    options.suiteId ?? "kernel-e2e-v1",
    trialsPerTask,
    results,
  );
}
