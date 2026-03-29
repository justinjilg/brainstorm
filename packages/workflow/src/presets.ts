import type { WorkflowDefinition } from "@brainst0rm/shared";

export const PRESET_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "implement-feature",
    name: "Implement Feature",
    description: "Full feature implementation: plan → code → review → fix loop",
    communicationMode: "handoff",
    maxIterations: 3,
    steps: [
      {
        id: "plan",
        agentRole: "architect",
        description:
          "Create a detailed implementation plan with file structure, interfaces, and step-by-step instructions",
        inputArtifacts: [],
        outputArtifact: "spec",
        outputSchema: "implementation-spec",
        isReviewStep: false,
      },
      {
        id: "code",
        agentRole: "coder",
        description: "Implement the code according to the specification",
        inputArtifacts: ["spec"],
        outputArtifact: "code",
        isReviewStep: false,
      },
      {
        id: "review",
        agentRole: "reviewer",
        description:
          "Review the implementation for correctness, security, and adherence to the spec",
        inputArtifacts: ["spec", "code"],
        outputArtifact: "review",
        outputSchema: "review-result",
        isReviewStep: true,
        loopBackTo: "code",
      },
    ],
  },
  {
    id: "fix-bug",
    name: "Fix Bug",
    description: "Bug diagnosis → fix → review",
    communicationMode: "handoff",
    maxIterations: 2,
    steps: [
      {
        id: "diagnose",
        agentRole: "debugger",
        description: "Identify the root cause of the bug and recommend a fix",
        inputArtifacts: [],
        outputArtifact: "diagnosis",
        outputSchema: "debug-result",
        isReviewStep: false,
      },
      {
        id: "fix",
        agentRole: "coder",
        description: "Implement the fix based on the diagnosis",
        inputArtifacts: ["diagnosis"],
        outputArtifact: "code",
        isReviewStep: false,
      },
      {
        id: "verify",
        agentRole: "reviewer",
        description:
          "Verify the fix addresses the root cause without introducing new issues",
        inputArtifacts: ["diagnosis", "code"],
        outputArtifact: "review",
        outputSchema: "review-result",
        isReviewStep: true,
        loopBackTo: "fix",
      },
    ],
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Single-step code review with quality model",
    communicationMode: "handoff",
    maxIterations: 1,
    steps: [
      {
        id: "review",
        agentRole: "reviewer",
        description:
          "Review the code for bugs, security issues, performance problems, and style",
        inputArtifacts: [],
        outputArtifact: "review",
        outputSchema: "review-result",
        isReviewStep: false, // no loop — single pass
      },
    ],
  },
  {
    id: "explain",
    name: "Explain",
    description: "Technical explanation with quality model",
    communicationMode: "handoff",
    maxIterations: 1,
    steps: [
      {
        id: "explain",
        agentRole: "analyst",
        description: "Provide a clear, thorough technical explanation",
        inputArtifacts: [],
        outputArtifact: "explanation",
        isReviewStep: false,
      },
    ],
  },
];

export function getPresetWorkflow(id: string): WorkflowDefinition | undefined {
  return PRESET_WORKFLOWS.find((w) => w.id === id);
}

/**
 * Auto-select a preset workflow from natural language.
 */
export function autoSelectPreset(description: string): string | null {
  const lower = description.toLowerCase();

  if (/\b(build|implement|add|create|scaffold|new feature)\b/.test(lower))
    return "implement-feature";
  if (/\b(fix|debug|error|broken|bug|crash|failing)\b/.test(lower))
    return "fix-bug";
  if (/\b(review|check|audit|inspect)\b/.test(lower)) return "code-review";
  if (/\b(explain|what is|how does|why|describe|understand)\b/.test(lower))
    return "explain";

  return null;
}
