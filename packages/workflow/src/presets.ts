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
  {
    id: "consensus-review",
    name: "Consensus Review",
    description:
      "3-reviewer parallel code review with consensus voting. Security + code quality + style reviewers on different models. 2-of-3 must pass.",
    communicationMode: "parallel",
    maxIterations: 1,
    steps: [
      {
        id: "security-review",
        agentRole: "security-reviewer",
        description:
          "Security review: auth, injection, credentials, input validation",
        inputArtifacts: [],
        outputArtifact: "security-review",
        outputSchema: "review-result",
        isReviewStep: false,
      },
      {
        id: "quality-review",
        agentRole: "code-reviewer",
        description:
          "Code quality review: correctness, error handling, API design",
        inputArtifacts: [],
        outputArtifact: "quality-review",
        outputSchema: "review-result",
        isReviewStep: false,
      },
      {
        id: "style-review",
        agentRole: "style-reviewer",
        description: "Style review: naming, organization, idiomatic patterns",
        inputArtifacts: [],
        outputArtifact: "style-review",
        outputSchema: "review-result",
        isReviewStep: false,
      },
    ],
  },
  {
    id: "feature-pipeline",
    name: "Feature Pipeline",
    description:
      "Full SDLC pipeline: spec → design → implement → review → test → compliance → integrate. Each phase has mandatory gates.",
    communicationMode: "handoff",
    maxIterations: 2,
    steps: [
      {
        id: "spec",
        agentRole: "product-manager",
        description: "Write feature specification with acceptance criteria",
        inputArtifacts: [],
        outputArtifact: "spec",
        outputSchema: "feature-spec",
        isReviewStep: false,
      },
      {
        id: "design",
        agentRole: "architect",
        description: "Design architecture, data model, API surface",
        inputArtifacts: ["spec"],
        outputArtifact: "design",
        outputSchema: "architecture-design",
        isReviewStep: false,
      },
      {
        id: "implement",
        agentRole: "coder",
        description: "Write compilable code. Gate: build must pass.",
        inputArtifacts: ["spec", "design"],
        outputArtifact: "code",
        isReviewStep: false,
      },
      {
        id: "review",
        agentRole: "reviewer",
        description:
          "3-agent consensus review. Gate: 2-of-3 must pass. Critical → loop to implement.",
        inputArtifacts: ["code"],
        outputArtifact: "review",
        outputSchema: "review-result",
        isReviewStep: true,
        loopBackTo: "implement",
      },
      {
        id: "test",
        agentRole: "qa",
        description: "Write tests and run them. Gate: tests must pass.",
        inputArtifacts: ["code", "spec"],
        outputArtifact: "tests",
        isReviewStep: false,
      },
      {
        id: "compliance",
        agentRole: "compliance",
        description: "Map implementation to SOC2/HIPAA controls with evidence",
        inputArtifacts: ["code", "spec"],
        outputArtifact: "compliance",
        isReviewStep: false,
      },
      {
        id: "integrate",
        agentRole: "devops",
        description: "CI/CD pipeline and dashboard integration",
        inputArtifacts: ["code", "tests"],
        outputArtifact: "integration",
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
