import type { AgentProfile, Artifact, WorkflowRun, WorkflowStepDef } from '@brainstorm/shared';
import { buildAgentSystemPrompt } from '@brainstorm/agents';

export interface FilteredContext {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

/**
 * Build context for a workflow step based on communication mode.
 *
 * Handoff: agent sees only its input artifacts + original request.
 * Shared: agent sees full conversation history from all prior agents.
 */
export function buildStepContext(
  step: WorkflowStepDef,
  agent: AgentProfile,
  run: WorkflowRun,
  isRetryAfterReject: boolean,
): FilteredContext {
  if (run.communicationMode === 'shared') {
    return buildSharedContext(step, agent, run, isRetryAfterReject);
  }
  return buildHandoffContext(step, agent, run, isRetryAfterReject);
}

function buildHandoffContext(
  step: WorkflowStepDef,
  agent: AgentProfile,
  run: WorkflowRun,
  isRetryAfterReject: boolean,
): FilteredContext {
  const systemPrompt = buildAgentSystemPrompt(agent, step.description);
  const messages: FilteredContext['messages'] = [];

  // Original user request
  messages.push({ role: 'user', content: run.description });

  // Input artifacts from previous steps
  for (const artifactId of step.inputArtifacts) {
    // Find the most recent artifact with this ID for the current or most recent iteration
    const artifact = findLatestArtifact(run.artifacts, artifactId, run.iteration);
    if (!artifact) continue;

    messages.push({
      role: 'assistant',
      content: `[${artifact.id} from ${artifact.agentId}]:\n\n${artifact.content}`,
    });
  }

  // If retrying after reviewer rejection, add the review feedback
  if (isRetryAfterReject) {
    const reviewArtifact = findLatestArtifact(run.artifacts, 'review', run.iteration - 1);
    if (reviewArtifact) {
      messages.push({
        role: 'user',
        content: `The reviewer rejected the previous implementation. Please address these issues:\n\n${reviewArtifact.content}`,
      });
    }
  }

  return { systemPrompt, messages };
}

function buildSharedContext(
  step: WorkflowStepDef,
  agent: AgentProfile,
  run: WorkflowRun,
  isRetryAfterReject: boolean,
): FilteredContext {
  const systemPrompt = buildAgentSystemPrompt(agent, step.description);
  const messages: FilteredContext['messages'] = [];

  // Original user request
  messages.push({ role: 'user', content: run.description });

  // All prior artifacts in chronological order
  const sorted = [...run.artifacts].sort((a, b) => a.timestamp - b.timestamp);
  for (const artifact of sorted) {
    messages.push({
      role: 'assistant',
      content: `[${artifact.agentId} — ${artifact.id}]:\n\n${artifact.content}`,
    });
  }

  // Current step instruction
  messages.push({
    role: 'user',
    content: `Now it's your turn as ${agent.displayName}. ${step.description}`,
  });

  return { systemPrompt, messages };
}

function findLatestArtifact(artifacts: Artifact[], id: string, maxIteration: number): Artifact | undefined {
  // Find artifact matching id at the current or most recent iteration
  for (let i = maxIteration; i >= 0; i--) {
    const found = artifacts.find((a) => a.id === id && a.iteration === i);
    if (found) return found;
  }
  // Fallback: any artifact with this ID
  return [...artifacts].reverse().find((a: Artifact) => a.id === id);
}
