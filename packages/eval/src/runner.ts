import { loadConfig } from '@brainstorm/config';
import { getDb } from '@brainstorm/db';
import { createProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import { createDefaultToolRegistry } from '@brainstorm/tools';
import { runAgentLoop, buildSystemPrompt, SessionManager } from '@brainstorm/core';
import { createLogger } from '@brainstorm/shared';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Probe, ProbeResult } from './types.js';
import { scoreProbe } from './scorer.js';

const log = createLogger('eval');

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
export async function runProbe(probe: Probe, options: RunnerOptions = {}): Promise<ProbeResult> {
  const startTime = Date.now();
  const timeout = probe.timeout_ms ?? options.defaultTimeout ?? 30000;

  // Create sandbox directory for probe setup files
  const sandboxDir = join(tmpdir(), `brainstorm-eval-${probe.id}-${Date.now()}`);
  mkdirSync(sandboxDir, { recursive: true });

  try {
    // Write setup files
    if (probe.setup?.files) {
      for (const [path, content] of Object.entries(probe.setup.files)) {
        const fullPath = join(sandboxDir, path);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content, 'utf-8');
      }
    }

    // Use sandboxDir as the agent's working directory so model-generated files
    // end up in the sandbox (where the scorer checks for them)
    const configDir = options.projectDir ?? process.cwd();
    const config = loadConfig(configDir);
    const db = getDb();
    const registry = await createProviderRegistry(config);
    const costTracker = new CostTracker(db, config.budget);
    const router = new BrainstormRouter(config, registry, costTracker);
    const tools = createDefaultToolRegistry();
    const sessionManager = new SessionManager(db);
    const session = sessionManager.start(sandboxDir);
    const { prompt: systemPrompt } = buildSystemPrompt(sandboxDir);

    sessionManager.addUserMessage(probe.prompt);

    const toolCalls: Array<{ name: string; argsPreview: string }> = [];
    let output = '';
    let steps = 0;

    // Run with timeout
    const runPromise = (async () => {
      for await (const event of runAgentLoop(sessionManager.getHistory(), {
        config, registry, router, costTracker, tools,
        sessionId: session.id, projectPath: sandboxDir, systemPrompt,
        ...(options.modelId && options.modelId !== 'default' ? { preferredModelId: options.modelId } : {}),
        ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
      })) {
        switch (event.type) {
          case 'text-delta':
            output += event.delta;
            break;
          case 'tool-call-start':
            toolCalls.push({
              name: event.toolName,
              argsPreview: JSON.stringify(event.args).slice(0, 100),
            });
            steps++;
            break;
          case 'error':
            throw event.error;
        }
      }
    })();

    // Race against timeout
    await Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Probe timed out after ${timeout}ms`)), timeout)),
    ]);

    const durationMs = Date.now() - startTime;
    const cost = costTracker.getSessionCost();

    // Score the result
    const checks = scoreProbe(probe, { output, toolCalls, steps, sandboxDir });

    return {
      probeId: probe.id,
      capability: probe.capability,
      passed: checks.every((c) => c.passed),
      checks,
      modelId: options.modelId ?? 'default',
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
      modelId: options.modelId ?? 'default',
      cost: 0,
      steps: 0,
      toolCalls: [],
      output: '',
      durationMs: Date.now() - startTime,
      error: String(error?.message ?? error),
    };
  } finally {
    // Clean up sandbox
    try {
      if (existsSync(sandboxDir)) rmSync(sandboxDir, { recursive: true });
    } catch { /* best effort cleanup */ }
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
    log.info({ probeId: probe.id, capability: probe.capability }, 'Running probe');
    const result = await runProbe(probe, options);
    results.push(result);
    log.info({
      probeId: probe.id,
      passed: result.passed,
      cost: result.cost,
      durationMs: result.durationMs,
    }, result.passed ? 'Probe passed' : 'Probe failed');
  }

  return results;
}
