// ── Probe Definition ─────────────────────────────────────────────────

export type CapabilityDimension =
  | "tool-selection"
  | "tool-sequencing"
  | "code-correctness"
  | "multi-step"
  | "instruction-adherence"
  | "context-utilization"
  | "self-correction";

export interface ProbeVerification {
  /** Tool names that must appear in the tool call log */
  tool_calls_include?: string[];
  /** Tool names that must NOT appear */
  tool_calls_exclude?: string[];
  /** Strings that must appear in the final text output */
  answer_contains?: string[];
  /** Strings that must NOT appear in the final text output */
  answer_excludes?: string[];
  /** If true, run tsc --noEmit on generated code */
  code_compiles?: boolean;
  /** Files that must be modified during the probe */
  files_modified?: string[];
  /** Minimum number of agentic steps */
  min_steps?: number;
  /** Maximum number of agentic steps (efficiency bound) */
  max_steps?: number;
  /** If true, the model should ask for clarification (ambiguous prompt test) */
  must_ask_user?: boolean;
}

export interface Probe {
  /** Unique probe identifier (e.g., "tool-select-01") */
  id: string;
  /** Which capability dimension this probe measures */
  capability: CapabilityDimension;
  /** The prompt sent to the agentic loop */
  prompt: string;
  /** Temporary files to create in the sandbox before running */
  setup?: { files: Record<string, string> };
  /** How to verify the result */
  verify: ProbeVerification;
  /** Timeout in milliseconds (default: 30000) */
  timeout_ms?: number;
  /**
   * Which workspace the agent's tools should operate against.
   * - "project" (default): the brainstorm project directory — agent can
   *   search the real codebase. Use for tool-selection, tool-sequencing,
   *   context-utilization, and other introspection probes.
   * - "sandbox": an isolated tmpdir — agent writes generated files there.
   *   Use for code-correctness probes that expect a clean slate.
   */
  workspace?: "project" | "sandbox";
}

// ── Probe Result ─────────────────────────────────────────────────────

export interface ProbeResult {
  /** Probe ID */
  probeId: string;
  /** Which capability was tested */
  capability: CapabilityDimension;
  /** Whether all verification checks passed */
  passed: boolean;
  /** Individual check results */
  checks: CheckResult[];
  /** Model that was used */
  modelId: string;
  /** Total cost of running this probe */
  cost: number;
  /** Number of agentic steps taken */
  steps: number;
  /** Tool calls made (name + args summary) */
  toolCalls: Array<{ name: string; argsPreview: string }>;
  /** Final text output */
  output: string;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Error if the probe failed to run (not a verification failure) */
  error?: string;
}

export interface CheckResult {
  check: string;
  passed: boolean;
  detail?: string;
}

// ── Eval Run ─────────────────────────────────────────────────────────

export interface EvalRun {
  /** Unique run ID */
  id: string;
  /** Model evaluated */
  modelId: string;
  /** When the run started */
  startedAt: number;
  /** When the run completed */
  completedAt?: number;
  /** Individual probe results */
  results: ProbeResult[];
  /** Aggregate scores per capability dimension (0-1) */
  scores: Record<CapabilityDimension, number>;
  /** Total cost of the eval run */
  totalCost: number;
}

// ── Capability Scorecard ─────────────────────────────────────────────

export interface CapabilityScorecard {
  modelId: string;
  evaluatedAt: number;
  dimensions: Record<
    CapabilityDimension,
    {
      score: number;
      passed: number;
      total: number;
    }
  >;
  overall: {
    score: number;
    passed: number;
    total: number;
    cost: number;
  };
}
