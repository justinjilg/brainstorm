/**
 * @brainstorm/sdk — Programmatic API for Brainstorm.
 *
 * Use this SDK to integrate Brainstorm's intelligent model routing,
 * task classification, codebase analysis, and agent execution
 * into CI/CD pipelines, scripts, and other tools.
 *
 * ```ts
 * import { Brainstorm } from '@brainstorm/sdk';
 *
 * const bs = new Brainstorm({ projectPath: '.' });
 * const result = await bs.run('fix the failing test in auth.ts');
 * console.log(result.text);
 * ```
 */

import { loadConfig, type BrainstormConfig } from "@brainstorm/config";
import { getDb, closeDb } from "@brainstorm/db";
import {
  createProviderRegistry,
  type ResolvedKeys,
} from "@brainstorm/providers";
import { BrainstormRouter, CostTracker } from "@brainstorm/router";
import {
  runAgentLoop,
  buildSystemPrompt,
  SessionManager,
} from "@brainstorm/core";
import type { AgentEvent } from "@brainstorm/shared";
import { createDefaultToolRegistry } from "@brainstorm/tools";
import { analyzeProject, type ProjectAnalysis } from "@brainstorm/ingest";
import { generateAllDocs, type DocgenResult } from "@brainstorm/docgen";

export interface BrainstormOptions {
  /** Path to the project directory (default: cwd). */
  projectPath?: string;
  /** Override the routing strategy. */
  strategy?: "quality-first" | "cost-first" | "combined" | "capability";
  /** Force a specific model (bypass routing). */
  model?: string;
  /** Maximum agentic steps (default: 10). */
  maxSteps?: number;
  /** Enable tool use (default: true). */
  tools?: boolean;
  /** Budget limit per run in dollars. */
  budget?: number;
  /** API keys as a map (alternative to environment variables). */
  apiKeys?: Record<string, string>;
}

export interface RunResult {
  text: string;
  modelUsed: string;
  toolCalls: number;
  cost: number;
  events: AgentEvent[];
}

/**
 * Brainstorm SDK — programmatic access to intelligent model routing and agents.
 */
export class Brainstorm {
  private config: BrainstormConfig;
  private projectPath: string;
  private opts: BrainstormOptions;

  constructor(opts: BrainstormOptions = {}) {
    this.opts = opts;
    this.projectPath = opts.projectPath ?? process.cwd();
    this.config = loadConfig();
    if (opts.strategy) {
      // Will be applied when router is created
    }
  }

  /**
   * Run a prompt through the agent loop with intelligent routing.
   * Returns the agent's response text, model used, and cost.
   */
  async run(prompt: string): Promise<RunResult> {
    const db = getDb();
    const keyMap = new Map<string, string>();

    // Apply any provided API keys
    if (this.opts.apiKeys) {
      for (const [key, value] of Object.entries(this.opts.apiKeys)) {
        keyMap.set(key, value);
        process.env[key] = value;
      }
    }

    const resolvedKeys: ResolvedKeys = {
      get: (name: string) => keyMap.get(name) ?? null,
    };
    const registry = await createProviderRegistry(this.config, resolvedKeys);
    const costTracker = new CostTracker(db, this.config.budget);
    const tools = createDefaultToolRegistry();
    const sessionManager = new SessionManager(db);
    const { prompt: systemPrompt, frontmatter } = buildSystemPrompt(
      this.projectPath,
    );
    const router = new BrainstormRouter(
      this.config,
      registry,
      costTracker,
      frontmatter,
    );

    if (this.opts.strategy) {
      router.setStrategy(this.opts.strategy);
    }

    const session = sessionManager.start(this.projectPath);
    sessionManager.addUserMessage(prompt);

    let fullResponse = "";
    let modelUsed = "unknown";
    let toolCallCount = 0;
    const events: AgentEvent[] = [];

    for await (const event of runAgentLoop(sessionManager.getHistory(), {
      config: this.config,
      registry,
      router,
      costTracker,
      tools,
      sessionId: session.id,
      projectPath: this.projectPath,
      systemPrompt,
      disableTools: this.opts.tools === false,
      preferredModelId: this.opts.model,
      maxSteps: this.opts.maxSteps ?? 10,
    })) {
      events.push(event);
      switch (event.type) {
        case "text-delta":
          fullResponse += event.delta;
          break;
        case "routing":
          modelUsed = event.decision.model.name;
          break;
        case "tool-call-start":
          toolCallCount++;
          break;
      }
    }

    const cost = costTracker.getSessionCost();
    closeDb();

    return {
      text: fullResponse,
      modelUsed,
      toolCalls: toolCallCount,
      cost,
      events,
    };
  }

  /**
   * Classify a task and return routing information.
   */
  classify(prompt: string): {
    type: string;
    complexity: string;
    model: string;
    strategy: string;
    reason: string;
  } {
    const db = getDb();
    const costTracker = new CostTracker(db, this.config.budget);
    const registry = { getModel: () => null } as any; // Minimal for classify-only
    const router = new BrainstormRouter(
      this.config,
      registry,
      costTracker,
      null,
    );

    if (this.opts.strategy) {
      router.setStrategy(this.opts.strategy);
    }

    const task = router.classify(prompt);
    const decision = router.route(task, 0);

    closeDb();

    return {
      type: task.type,
      complexity: task.complexity,
      model: decision.model?.name ?? "unknown",
      strategy: decision.strategy ?? "unknown",
      reason: decision.reason ?? "",
    };
  }

  /**
   * Analyze a project's codebase (deterministic, no LLM).
   */
  analyze(projectPath?: string): ProjectAnalysis {
    return analyzeProject(projectPath ?? this.projectPath);
  }

  /**
   * Generate documentation from analysis.
   */
  generateDocs(analysis: ProjectAnalysis, outputDir?: string): DocgenResult {
    return generateAllDocs(analysis, outputDir);
  }
}

// Re-export key types for SDK consumers
export type { ProjectAnalysis } from "@brainstorm/ingest";
export type { DocgenResult } from "@brainstorm/docgen";
export type { AgentEvent } from "@brainstorm/shared";
export type { BrainstormConfig } from "@brainstorm/config";
