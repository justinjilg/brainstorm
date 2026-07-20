export type E2EDomain =
  | "coding"
  | "web"
  | "documentation"
  | "infrastructure"
  | "adversarial";

export type VerificationKind =
  | "command"
  | "static-web"
  | "document"
  | "structured-data"
  | "policy";

export interface FileAssertion {
  path: string;
  contains?: string[];
  excludes?: string[];
}

export interface E2EVerificationContract {
  kind: VerificationKind;
  requiredFiles?: string[];
  commands?: string[];
  fileAssertions?: FileAssertion[];
  /** Rubric id for independently graded, subjective quality. */
  rubric?: "web-quality-v1" | "documentation-quality-v1";
  /** Whether the task must finish without mutating the workspace. */
  noMutation?: boolean;
}

export interface E2ETask {
  id: string;
  version: 1;
  domain: E2EDomain;
  title: string;
  prompt: string;
  workspace: "sandbox";
  setup?: { files: Record<string, string> };
  verify: E2EVerificationContract;
  maxSteps: number;
  timeoutMs: number;
  tags: string[];
}

export type TrialStatus = "succeeded" | "failed" | "aborted" | "errored";

/**
 * One repeated attempt at an end-to-end task. Axis scores are independent:
 * correct-but-slow work remains correct, and safe refusal can score governance
 * even though it intentionally produces no artifact.
 */
export interface E2ETrialResult {
  taskId: string;
  modelId: string;
  trial: number;
  status: TrialStatus;
  correctness: number;
  quality?: number;
  efficiency: number;
  resilience: number;
  governance: number;
  durationMs: number;
  costUsd: number;
  attempts: number;
  recovered: boolean;
  silentFailure: boolean;
  stateCorruption: boolean;
  artifactPaths: string[];
  error?: string;
}

export type ScoreAxis =
  | "correctness"
  | "quality"
  | "efficiency"
  | "resilience"
  | "governance";

export interface AxisScore {
  mean: number;
  samples: number;
  /** Wilson interval for binary pass/fail at the 0.9 graduation threshold. */
  passRate: number;
  passLower95: number;
  passUpper95: number;
}

export interface E2EScorecard {
  suiteId: string;
  generatedAt: number;
  trialsPerTask: number;
  taskCount: number;
  resultCount: number;
  axes: Record<ScoreAxis, AxisScore>;
  verifiedCompletionRate: number;
  usableTerminalRate: number;
  recoverySuccessRate: number | null;
  silentFailureRate: number;
  stateCorruptionRate: number;
  totalCostUsd: number;
  meanDurationMs: number;
}

export interface E2EVerificationCheck {
  id: string;
  passed: boolean;
  detail: string;
  durationMs?: number;
}

export interface E2EArtifactEvidence {
  path: string;
  sha256: string;
  bytes: number;
}

export interface E2EVerificationResult {
  passed: boolean;
  checks: E2EVerificationCheck[];
  artifacts: E2EArtifactEvidence[];
  durationMs: number;
}
