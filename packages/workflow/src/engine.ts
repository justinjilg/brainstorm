import { randomUUID } from 'node:crypto';
import type {
  WorkflowDefinition, WorkflowRun, WorkflowStepRun, WorkflowStepDef,
  WorkflowEvent, Artifact, AgentProfile, StepStatus,
} from '@brainstorm/shared';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import { createDefaultToolRegistry, type ToolRegistry } from '@brainstorm/tools';
import { runAgentLoop, buildSystemPrompt } from '@brainstorm/core';
import { AgentManager, buildAgentSystemPrompt } from '@brainstorm/agents';
import { buildStepContext } from './context-filter.js';
import { extractConfidence, determineEscalation, isReviewApproved } from './confidence.js';

export interface WorkflowEngineOptions {
  config: BrainstormConfig;
  db: any;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  agentManager: AgentManager;
  projectPath: string;
}

export async function* runWorkflow(
  definition: WorkflowDefinition,
  userRequest: string,
  agentOverrides: Record<string, string>, // role → agentId overrides
  options: WorkflowEngineOptions,
): AsyncGenerator<WorkflowEvent> {
  const { router, costTracker, agentManager, config, registry, projectPath } = options;

  // Initialize the run
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowId: definition.id,
    description: userRequest,
    status: 'running',
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
    const overrideId = agentOverrides[step.agentRole] ?? agentOverrides[step.id];
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
    const agent = stepAgents.get(step.id)!;
    const task = router.classify(userRequest);
    const decision = router.route(task);
    forecast.push({ step: step.id, cost: decision.estimatedCost });
  }
  const totalEstimate = forecast.reduce((sum, f) => sum + f.cost, 0) * 1.3; // safety margin
  run.estimatedCost = totalEstimate;

  yield { type: 'cost-forecast', estimated: totalEstimate, breakdown: forecast };
  yield { type: 'workflow-started', run };

  // Execute steps
  let stepIndex = 0;
  while (stepIndex < definition.steps.length) {
    const stepDef = definition.steps[stepIndex];
    const agent = stepAgents.get(stepDef.id)!;

    // Create step run
    const stepRun: WorkflowStepRun = {
      id: randomUUID(),
      stepDefId: stepDef.id,
      agentId: agent.id,
      status: 'running',
      cost: 0,
      iteration: run.iteration,
      startedAt: Math.floor(Date.now() / 1000),
    };
    run.steps.push(stepRun);

    yield { type: 'step-started', step: stepRun, agent };

    try {
      // Build context for this step
      const isRetry = run.iteration > 0 && stepDef.loopBackTo !== undefined;
      const ctx = buildStepContext(stepDef, agent, run, isRetry);

      // Build tools (respect agent's allowedTools)
      const tools = createDefaultToolRegistry();

      // Run the agent loop
      let fullResponse = '';
      const sessionId = run.id;
      const systemPrompt = ctx.systemPrompt;

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
      })) {
        // Forward agent events as step progress
        yield { type: 'step-progress', stepId: stepDef.id, event };

        if (event.type === 'text-delta') {
          fullResponse += event.delta;
        }
        if (event.type === 'done') {
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
      stepRun.artifactId = artifact.id;
      stepRun.status = 'completed';
      stepRun.completedAt = Math.floor(Date.now() / 1000);

      yield { type: 'step-completed', step: stepRun, artifact };

      // Check confidence escalation
      const escalation = determineEscalation(
        artifact.confidence,
        agent.confidenceThreshold,
        run.iteration < run.maxIterations,
      );
      if (escalation === 'pause') {
        yield { type: 'confidence-escalation', step: stepRun, confidence: artifact.confidence, action: 'paused — low confidence' };
        run.status = 'paused';
        return; // Pause workflow for user decision
      }
      if (escalation === 'retry') {
        yield { type: 'confidence-escalation', step: stepRun, confidence: artifact.confidence, action: 'retrying step with same model' };
        continue; // Re-run same step
      }

      // Handle review step rejection → loop back
      if (stepDef.isReviewStep && !isReviewApproved(artifact)) {
        if (run.iteration < run.maxIterations && stepDef.loopBackTo) {
          run.iteration++;
          const loopBackIndex = definition.steps.findIndex((s) => s.id === stepDef.loopBackTo);
          if (loopBackIndex >= 0) {
            yield {
              type: 'review-rejected',
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
      stepRun.status = 'failed';
      stepRun.error = error.message;
      stepRun.completedAt = Math.floor(Date.now() / 1000);

      yield { type: 'step-failed', step: stepRun, error };

      // Record failure for routing fallback
      router.recordFailure(agent.modelId, error.message);

      run.status = 'failed';
      yield { type: 'workflow-failed', run, error };
      return;
    }
  }

  run.status = 'completed';
  run.updatedAt = Math.floor(Date.now() / 1000);
  yield { type: 'workflow-completed', run };
}

function shouldUseTools(step: WorkflowStepDef, agent: AgentProfile): boolean {
  if (agent.allowedTools === 'all') return true;
  if (Array.isArray(agent.allowedTools) && agent.allowedTools.length > 0) return true;
  return false;
}

function detectContentType(content: string): Artifact['contentType'] {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json'; } catch {}
  }
  if (trimmed.includes('```')) return 'code';
  if (trimmed.includes('# ') || trimmed.includes('## ')) return 'markdown';
  return 'text';
}

function createDefaultAgent(role: string): AgentProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `default-${role}`,
    displayName: role.charAt(0).toUpperCase() + role.slice(1),
    role: role as any,
    description: '',
    modelId: 'auto',
    allowedTools: role === 'coder' ? 'all' : ['file_read', 'glob', 'grep'],
    budget: { exhaustionAction: 'downgrade' },
    confidenceThreshold: 0.7,
    maxSteps: 10,
    fallbackChain: [],
    guardrails: {},
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
  };
}
