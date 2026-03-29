import type {
  WorkflowDefinition,
  WorkflowStepDef,
  AgentRole,
} from "@brainst0rm/shared";

/**
 * Subtask definition produced by the orchestrator's decomposition.
 * Each subtask specifies what capabilities it needs so the router
 * can assign the optimal model.
 */
export interface Subtask {
  id: string;
  description: string;
  requiredCapabilities: Array<
    | "tool-calling"
    | "reasoning"
    | "code-generation"
    | "large-context"
    | "vision"
  >;
  complexity: "trivial" | "simple" | "moderate" | "complex";
  dependsOn: string[];
  estimatedTokens?: number;
}

export interface DecompositionResult {
  subtasks: Subtask[];
  summary: string;
}

/**
 * System prompt for the orchestrator-decompose role.
 * This agent takes a complex task and breaks it into subtasks
 * with explicit capability requirements for multi-model routing.
 */
export const DECOMPOSITION_PROMPT = `You are the task decomposition orchestrator. Your job is to analyze a complex task and break it into focused subtasks that can be independently routed to the optimal model.

For each subtask, specify:
1. **id**: Short identifier (e.g., "search-codebase", "generate-auth", "review-changes")
2. **description**: Clear, actionable description of what this subtask does
3. **requiredCapabilities**: Which capabilities this subtask needs:
   - "tool-calling" — needs to read/write files, search code, run commands
   - "reasoning" — needs multi-step logical reasoning or debugging
   - "code-generation" — needs to write new code or modify existing code
   - "large-context" — needs to process or search through many files
   - "vision" — needs to analyze images or screenshots
4. **complexity**: trivial, simple, moderate, or complex
5. **dependsOn**: Array of subtask IDs that must complete before this one starts

Respond with valid JSON matching this structure:
{
  "summary": "Brief description of the overall decomposition strategy",
  "subtasks": [
    {
      "id": "search-codebase",
      "description": "Search for all files related to authentication",
      "requiredCapabilities": ["tool-calling", "large-context"],
      "complexity": "simple",
      "dependsOn": []
    },
    {
      "id": "design-refactor",
      "description": "Design the new auth architecture based on search results",
      "requiredCapabilities": ["reasoning"],
      "complexity": "complex",
      "dependsOn": ["search-codebase"]
    }
  ]
}

Guidelines:
- Keep subtasks focused — each should take 1-5 tool calls
- Identify parallelizable work (independent subtasks with no dependencies)
- Put search/discovery tasks first, then design, then implementation, then review
- A review subtask should always come last to verify the work`;

/**
 * Map capability requirements to agent roles.
 */
function capabilitiesToRole(caps: Subtask["requiredCapabilities"]): AgentRole {
  if (caps.includes("code-generation")) return "coder";
  if (caps.includes("reasoning")) return "architect";
  if (caps.includes("large-context") || caps.includes("tool-calling"))
    return "analyst";
  return "coder";
}

/**
 * Convert a decomposition result into a WorkflowDefinition
 * that the workflow engine can execute.
 */
export function decompositionToWorkflow(
  result: DecompositionResult,
  originalTask: string,
): WorkflowDefinition {
  const steps: WorkflowStepDef[] = result.subtasks.map((subtask, index) => ({
    id: subtask.id,
    agentRole: capabilitiesToRole(subtask.requiredCapabilities),
    description: subtask.description,
    inputArtifacts: subtask.dependsOn,
    outputArtifact: subtask.id,
    isReviewStep:
      index === result.subtasks.length - 1 &&
      subtask.description.toLowerCase().includes("review"),
  }));

  // Add a review step if the last step isn't already a review
  const lastStep = steps[steps.length - 1];
  if (!lastStep?.isReviewStep) {
    steps.push({
      id: "final-review",
      agentRole: "reviewer",
      description: "Review the completed work for correctness and quality",
      inputArtifacts: [lastStep?.id ?? ""].filter(Boolean),
      outputArtifact: "final-review",
      isReviewStep: true,
      loopBackTo: steps.find((s) => s.agentRole === "coder")?.id,
    });
  }

  return {
    id: `decomposed-${Date.now().toString(36)}`,
    name: `Decomposed: ${originalTask.slice(0, 60)}`,
    description: result.summary,
    steps,
    communicationMode: "handoff",
    maxIterations: 3,
  };
}
