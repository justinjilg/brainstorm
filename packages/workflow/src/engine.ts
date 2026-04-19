import { randomUUID } from "node:crypto";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowStepDef,
  WorkflowEvent,
  Artifact,
  AgentProfile,
  AgentRole,
  StepStatus,
} from "@brainst0rm/shared";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import {
  createDefaultToolRegistry,
  type ToolRegistry,
} from "@brainst0rm/tools";
import { runAgentLoop, buildSystemPrompt, loadSkills } from "@brainst0rm/core";
import { AgentManager, buildAgentSystemPrompt } from "@brainst0rm/agents";
import { buildStepContext } from "./context-filter.js";
import { writeArtifact } from "./artifact-store.js";
import {
  extractConfidence,
  determineEscalation,
  isReviewApproved,
} from "./confidence.js";

/**
 * Shell commands that may run as a workflow kill-gate. Each entry is a
 * prefix; the gate is accepted only if it starts with one of these AND
 * contains no shell metacharacters. Exported so tests can assert the
 * surface directly without spinning up a full workflow run.
 */
export const ALLOWED_GATE_PREFIXES = [
  "npm test",
  "npm run ",
  "npx turbo run ",
  "npx vitest",
  "git diff --quiet",
  "git status --porcelain",
  "make ",
  "cargo test",
  "cargo build",
  "go test",
  "pytest",
] as const;

/**
 * Validate a kill-gate command string before execution. Gates run via
 * /bin/sh -c, so a prefix match alone is not safe — "npm test; rm -rf /"
 * starts with "npm test" but chains a second command. This helper also
 * rejects any shell metacharacter that could chain, pipe, redirect, or
 * substitute ( `;`, `&`, `|`, backtick, `$`, `<`, `>`, parens, newlines ).
 * Plain whitespace-delimited arguments such as "npm run build --if-present"
 * still pass.
 */
export function validateGateCommand(gate: string): {
  allowed: boolean;
  reason?: string;
} {
  const trimmed = gate.trimStart();
  const prefixOk = ALLOWED_GATE_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  );
  if (!prefixOk) {
    return {
      allowed: false,
      reason: `Gate rejected: command not in allowlist. Allowed prefixes: ${ALLOWED_GATE_PREFIXES.join(", ")}`,
    };
  }
  if (/[;&|`$<>\n\r()]/.test(trimmed)) {
    return {
      allowed: false,
      reason:
        "Gate rejected: command contains shell metacharacters that would allow chaining or substitution",
    };
  }
  return { allowed: true };
}

export interface WorkflowEngineOptions {
  config: BrainstormConfig;
  db: any;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  agentManager: AgentManager;
  projectPath: string;
  /** Per-step model overrides: stepId → modelId. Used for cross-model workflows. */
  stepModelOverrides?: Record<string, string>;
  /** Build state tracker — if build is broken, workflow pauses before next step. */
  buildState?: { isBroken(): boolean; getLastError(): string | null };
}

export async function* runWorkflow(
  definition: WorkflowDefinition,
  userRequest: string,
  agentOverrides: Record<string, string>, // role → agentId overrides
  options: WorkflowEngineOptions,
): AsyncGenerator<WorkflowEvent> {
  const { router, costTracker, agentManager, config, registry, projectPath } =
    options;

  // Load skills once for the entire workflow — keyed by name for role-based injection
  const allSkills = loadSkills(projectPath);
  const skillMap = new Map<string, { description: string; content: string }>();
  for (const s of allSkills) {
    skillMap.set(s.name, { description: s.description, content: s.content });
  }

  // Initialize the run
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowId: definition.id,
    description: userRequest,
    status: "running",
    steps: [],
    artifacts: [],
    totalCost: 0,
    estimatedCost: 0,
    iteration: 0,
    maxIterations: definition.maxIterations,
    communicationMode: definition.communicationMode,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
  };

  // Resolve agents for each step
  const stepAgents = new Map<string, AgentProfile>();
  for (const step of definition.steps) {
    const overrideId =
      agentOverrides[step.agentRole] ?? agentOverrides[step.id];
    let agent: AgentProfile | null = null;

    if (overrideId) {
      agent = agentManager.get(overrideId);
    }
    if (!agent && step.agentId) {
      agent = agentManager.get(step.agentId);
    }
    if (!agent) {
      agent = agentManager.resolveByRole(step.agentRole);
    }
    if (!agent) {
      // Create a default agent for this role
      agent = createDefaultAgent(step.agentRole);
    }
    stepAgents.set(step.id, agent);
  }

  // Cost forecast
  const forecast: Array<{ step: string; cost: number }> = [];
  for (const step of definition.steps) {
    const agent = stepAgents.get(step.id);
    if (!agent) continue;
    const task = router.classify(userRequest);
    const decision = router.route(task);
    forecast.push({ step: step.id, cost: decision.estimatedCost });
  }
  const safetyMargin = config.general?.costSafetyMargin ?? 1.3;
  const totalEstimate =
    forecast.reduce((sum, f) => sum + f.cost, 0) * safetyMargin;
  run.estimatedCost = totalEstimate;

  yield {
    type: "cost-forecast",
    estimated: totalEstimate,
    breakdown: forecast,
  };
  yield { type: "workflow-started", run };

  // Execute steps
  let stepIndex = 0;
  const MAX_CONFIDENCE_RETRIES = 2;
  // Retry counter is scoped by stepIndex, not by loop iteration. The
  // previous version declared `let confidenceRetries = 0` inside the
  // while body, so every `continue` (used below to re-run the same
  // step after a low-confidence escalation) re-entered the loop head
  // and reset the counter to 0 — MAX_CONFIDENCE_RETRIES was never
  // reachable and the step could loop indefinitely against the budget.
  let confidenceRetries = 0;
  let confidenceRetryStepIndex = stepIndex;
  while (stepIndex < definition.steps.length) {
    if (confidenceRetryStepIndex !== stepIndex) {
      confidenceRetries = 0;
      confidenceRetryStepIndex = stepIndex;
    }
    const stepDef = definition.steps[stepIndex];
    const agent = stepAgents.get(stepDef.id);
    if (!agent) {
      yield {
        type: "step-failed" as any,
        step: {
          id: randomUUID(),
          stepDefId: stepDef.id,
          agentId: "unknown",
          status: "failed" as const,
          cost: 0,
          iteration: run.iteration,
        },
        error: new Error(`No agent resolved for step "${stepDef.id}"`),
      };
      stepIndex++;
      continue;
    }

    // Create step run
    const stepRun: WorkflowStepRun = {
      id: randomUUID(),
      stepDefId: stepDef.id,
      agentId: agent.id,
      status: "running",
      cost: 0,
      iteration: run.iteration,
      startedAt: Math.floor(Date.now() / 1000),
    };
    run.steps.push(stepRun);

    yield { type: "step-started", step: stepRun, agent };

    // Check build state before executing step — pause if build is broken
    if (options.buildState) {
      const bs = options.buildState;
      if (bs.isBroken()) {
        yield {
          type: "workflow-paused",
          reason: `Build is broken: ${bs.getLastError()}. Fix before continuing.`,
          run,
        };
        stepRun.status = "skipped";
        stepRun.error = "Build broken — step skipped";
        break;
      }
    }

    try {
      // Build context for this step
      const isRetry = run.iteration > 0 && stepDef.loopBackTo !== undefined;
      const ctx = buildStepContext(stepDef, agent, run, isRetry, skillMap);

      // Build tools (respect agent's allowedTools)
      const tools = createDefaultToolRegistry();

      // Run the agent loop
      let fullResponse = "";
      const sessionId = run.id;
      const systemPrompt = ctx.systemPrompt;

      // Per-step model override for cross-model workflows
      const stepModelId = options.stepModelOverrides?.[stepDef.id];

      // Enforce per-agent tool allowlist via roleToolFilter
      const roleToolFilter =
        agent.allowedTools && agent.allowedTools !== "all"
          ? { allowedTools: agent.allowedTools as string[] }
          : undefined;

      for await (const event of runAgentLoop(ctx.messages, {
        config,
        registry,
        router,
        costTracker,
        tools,
        sessionId,
        projectPath,
        systemPrompt,
        disableTools: !shouldUseTools(stepDef, agent),
        roleToolFilter,
        ...(stepModelId ? { preferredModelId: stepModelId } : {}),
      })) {
        // Forward agent events as step progress
        yield { type: "step-progress", stepId: stepDef.id, event };

        if (event.type === "text-delta") {
          fullResponse += event.delta;
        }
        if (event.type === "done") {
          stepRun.cost = event.totalCost - run.totalCost;
          run.totalCost = event.totalCost;
        }
      }

      // Create artifact from response
      const artifact: Artifact = {
        id: stepDef.outputArtifact,
        stepId: stepDef.id,
        agentId: agent.id,
        content: fullResponse,
        contentType: detectContentType(fullResponse),
        metadata: {},
        confidence: 0,
        cost: stepRun.cost,
        timestamp: Math.floor(Date.now() / 1000),
        iteration: run.iteration,
      };

      // Extract confidence
      artifact.confidence = extractConfidence(artifact);

      run.artifacts.push(artifact);
      writeArtifact(run.id, artifact);
      stepRun.artifactId = artifact.id;
      stepRun.status = "completed";
      stepRun.completedAt = Math.floor(Date.now() / 1000);

      yield { type: "step-completed", step: stepRun, artifact };

      if (stepDef.killGates && stepDef.killGates.length > 0) {
        for (const gate of stepDef.killGates) {
          const verdict = validateGateCommand(gate);
          if (!verdict.allowed) {
            yield {
              type: "gate-failed" as const,
              step: stepRun,
              gate,
              output: verdict.reason ?? "Gate rejected",
            };
            run.status = "paused";
            return;
          }

          try {
            const { execFileSync } = await import("node:child_process");
            execFileSync("/bin/sh", ["-c", gate], {
              cwd: projectPath,
              timeout: 60000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            yield {
              type: "gate-passed",
              step: stepRun,
              gate,
            };
          } catch (err: any) {
            const output = (err.stderr?.toString() ?? err.message ?? "").slice(
              0,
              500,
            );
            yield {
              type: "gate-failed",
              step: stepRun,
              gate,
              output,
            };
            // Gate failed — pause workflow
            run.status = "paused";
            return;
          }
        }
      }

      // Check confidence escalation
      const escalation = determineEscalation(
        artifact.confidence,
        agent.confidenceThreshold,
        run.iteration < run.maxIterations,
      );
      if (escalation === "pause") {
        yield {
          type: "confidence-escalation",
          step: stepRun,
          confidence: artifact.confidence,
          action: "paused — low confidence",
        };
        run.status = "paused";
        return; // Pause workflow for user decision
      }
      if (escalation === "retry") {
        confidenceRetries++;
        if (confidenceRetries > MAX_CONFIDENCE_RETRIES) {
          yield {
            type: "confidence-escalation",
            step: stepRun,
            confidence: artifact.confidence,
            action: "max confidence retries reached — continuing",
          };
        } else {
          yield {
            type: "confidence-escalation",
            step: stepRun,
            confidence: artifact.confidence,
            action: `retrying step (${confidenceRetries}/${MAX_CONFIDENCE_RETRIES})`,
          };
          continue; // Re-run same step
        }
      }

      // Handle review step rejection → loop back
      if (stepDef.isReviewStep && !isReviewApproved(artifact)) {
        if (run.iteration < run.maxIterations && stepDef.loopBackTo) {
          run.iteration++;
          const loopBackIndex = definition.steps.findIndex(
            (s) => s.id === stepDef.loopBackTo,
          );
          if (loopBackIndex >= 0) {
            yield {
              type: "review-rejected",
              step: stepRun,
              reason: artifact.content.slice(0, 200),
              loopingBackTo: stepDef.loopBackTo,
            };
            stepIndex = loopBackIndex;
            continue;
          }
        }
      }

      stepIndex++;
    } catch (error: any) {
      stepRun.status = "failed";
      stepRun.error = error.message;
      stepRun.completedAt = Math.floor(Date.now() / 1000);

      yield { type: "step-failed", step: stepRun, error };

      // Record failure for routing fallback
      router.recordFailure(agent.modelId, error.message);

      run.status = "failed";
      yield { type: "workflow-failed", run, error };
      return;
    }
  }

  run.status = "completed";
  run.updatedAt = Math.floor(Date.now() / 1000);
  yield { type: "workflow-completed", run };
}

function shouldUseTools(step: WorkflowStepDef, agent: AgentProfile): boolean {
  if (agent.allowedTools === "all") return true;
  if (Array.isArray(agent.allowedTools) && agent.allowedTools.length > 0)
    return true;
  return false;
}

function detectContentType(content: string): Artifact["contentType"] {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  }
  if (trimmed.includes("```")) return "code";
  if (trimmed.includes("# ") || trimmed.includes("## ")) return "markdown";
  return "text";
}

function createDefaultAgent(role: string): AgentProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `default-${role}`,
    displayName: role.charAt(0).toUpperCase() + role.slice(1),
    role: role as AgentRole,
    description: "",
    modelId: "auto",
    allowedTools: role === "coder" ? "all" : ["file_read", "glob", "grep"],
    budget: { exhaustionAction: "downgrade" },
    confidenceThreshold: 0.7,
    maxSteps: 10,
    fallbackChain: [],
    guardrails: {},
    lifecycle: "active",
    createdAt: now,
    updatedAt: now,
  };
}
