/**
 * Orchestration Pipeline — 9-phase software development lifecycle.
 *
 * Combines patterns from:
 * - MetaGPT/ChatDev: role-based sequential pipeline
 * - Augment Intent: spec-driven coordination with parallel agents
 * - MapCoder: multi-stage per-task pipeline (recall → plan → generate → debug)
 *
 * Each phase dispatches to a role agent (.agent.md file) via the existing
 * subagent infrastructure. BrainstormRouter automatically selects the model
 * for each phase — no manual model selection.
 *
 * Phases: Spec → Architecture → Implementation → Review → Verify → Refactor → Deploy → Document → Report
 */

// ── Types ──────────────────────────────────────────────────────────

export type PipelinePhase =
  | "spec"
  | "architecture"
  | "implementation"
  | "review"
  | "verify"
  | "refactor"
  | "deploy"
  | "document"
  | "report";

export interface PhaseResult {
  phase: PipelinePhase;
  agentId: string;
  output: string;
  cost: number;
  toolCalls: string[];
  duration: number;
  success: boolean;
  error?: string;
}

export type PipelineEvent =
  | { type: "pipeline-started"; request: string; phases: PipelinePhase[] }
  | { type: "phase-started"; phase: PipelinePhase; agentId: string }
  | { type: "phase-completed"; result: PhaseResult }
  | { type: "phase-failed"; phase: PipelinePhase; error: string }
  | { type: "review-findings"; findings: ReviewFinding[]; hasCritical: boolean }
  | {
      type: "feedback-loop";
      from: PipelinePhase;
      to: PipelinePhase;
      reason: string;
    }
  | { type: "pipeline-completed"; results: PhaseResult[]; totalCost: number }
  | { type: "pipeline-paused"; phase: PipelinePhase; reason: string };

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  file?: string;
  line?: number;
  reviewer: string;
}

export interface PipelineOptions {
  projectPath: string;
  buildCommand?: string;
  testCommand?: string;
  deployCommands?: string[];
  deploy?: boolean;
  budget?: number;
  phases?: PipelinePhase[];
  resumeFrom?: PipelinePhase;
  dryRun?: boolean;
}

// ── Phase Configuration ─────────────────────────────────────────────

const PHASE_CONFIG: Record<
  PipelinePhase,
  {
    agentId: string;
    subagentType: string;
    parallel?: boolean;
    agents?: string[];
  }
> = {
  spec: { agentId: "product-manager", subagentType: "plan" },
  architecture: { agentId: "architect", subagentType: "plan" },
  implementation: { agentId: "coder", subagentType: "code" },
  review: {
    agentId: "code-reviewer",
    subagentType: "review",
    parallel: true,
    agents: ["security-reviewer", "code-reviewer", "style-reviewer"],
  },
  verify: { agentId: "build-verifier", subagentType: "code" },
  refactor: { agentId: "refactorer", subagentType: "code" },
  deploy: { agentId: "devops", subagentType: "code" },
  document: { agentId: "technical-writer", subagentType: "plan" },
  report: { agentId: "reporter", subagentType: "plan" },
};

const DEFAULT_PHASES: PipelinePhase[] = [
  "spec",
  "architecture",
  "implementation",
  "review",
  "verify",
  "refactor",
  "document",
  "report",
];

// ── Pipeline Engine ─────────────────────────────────────────────────

export interface PhaseDispatcher {
  /** Execute a single phase with a named agent. */
  runPhase(
    agentId: string,
    subagentType: string,
    prompt: string,
    opts: { budget: number; projectPath: string },
  ): Promise<{ text: string; cost: number; toolCalls: string[] }>;

  /** Execute multiple agents in parallel. */
  runParallel(
    specs: Array<{ agentId: string; subagentType: string; prompt: string }>,
    opts: { budget: number; projectPath: string },
  ): Promise<
    Array<{ agentId: string; text: string; cost: number; toolCalls: string[] }>
  >;

  /** Run a shell command. */
  runCommand(
    command: string,
    cwd: string,
  ): Promise<{ passed: boolean; output: string }>;
}

/**
 * Execute the full orchestration pipeline.
 *
 * Each phase dispatches to a role agent via the PhaseDispatcher.
 * BrainstormRouter handles model selection automatically.
 * Every run is captured as a trajectory for BrainstormLLM v2 training.
 */
export async function* runOrchestrationPipeline(
  request: string,
  dispatcher: PhaseDispatcher,
  options: PipelineOptions,
): AsyncGenerator<PipelineEvent> {
  // Trajectory capture — every pipeline run becomes training data
  const { TrajectoryRecorder } = await import("./trajectory-capture.js");
  const recorder = new TrajectoryRecorder(request, options.projectPath);
  const phases = options.phases ?? DEFAULT_PHASES;
  const budgetPerPhase = options.budget ? options.budget / phases.length : 1.0;
  const results: PhaseResult[] = [];
  let totalCost = 0;
  let specOutput = "";
  let designOutput = "";
  let implementationOutput = "";

  // Skip phases before resumeFrom
  let skipping = !!options.resumeFrom;

  // Helper: yield event AND record to trajectory
  function record(event: PipelineEvent) {
    recorder.recordEvent(event);
    return event;
  }

  yield record({ type: "pipeline-started", request, phases });

  for (const phase of phases) {
    if (skipping) {
      if (phase === options.resumeFrom) skipping = false;
      else continue;
    }

    // Budget guard
    if (options.budget && totalCost >= options.budget) {
      yield record({
        type: "pipeline-paused",
        phase,
        reason: `Budget exhausted: $${totalCost.toFixed(2)}`,
      });
      recorder.finalize();
      break;
    }

    // Skip deploy if not requested
    if (phase === "deploy" && !options.deploy) continue;

    const config = PHASE_CONFIG[phase];
    const startTime = Date.now();

    yield record({ type: "phase-started", phase, agentId: config.agentId });

    if (options.dryRun) {
      const result: PhaseResult = {
        phase,
        agentId: config.agentId,
        output: `[Dry run] Would dispatch ${config.agentId} (${config.subagentType})`,
        cost: 0,
        toolCalls: [],
        duration: 0,
        success: true,
      };
      results.push(result);
      yield record({ type: "phase-completed", result });
      continue;
    }

    try {
      // Build phase-specific prompt
      const prompt = buildPhasePrompt(phase, request, {
        spec: specOutput,
        design: designOutput,
        implementation: implementationOutput,
      });

      let result: PhaseResult;

      if (config.parallel && config.agents) {
        // Parallel phase (review)
        const parallelResults = await dispatcher.runParallel(
          config.agents.map((agentId) => ({
            agentId,
            subagentType: config.subagentType,
            prompt,
          })),
          { budget: budgetPerPhase, projectPath: options.projectPath },
        );

        const combinedOutput = parallelResults
          .map((r) => `### ${r.agentId}\n${r.text}`)
          .join("\n\n");
        const combinedCost = parallelResults.reduce(
          (sum, r) => sum + r.cost,
          0,
        );
        const combinedTools = parallelResults.flatMap((r) => r.toolCalls);

        result = {
          phase,
          agentId: config.agents.join("+"),
          output: combinedOutput,
          cost: combinedCost,
          toolCalls: combinedTools,
          duration: Date.now() - startTime,
          success: true,
        };

        // Check for critical review findings
        if (phase === "review") {
          const findings = parseReviewFindings(combinedOutput);
          const hasCritical = findings.some((f) => f.severity === "critical");
          yield record({ type: "review-findings", findings, hasCritical });

          if (hasCritical) {
            yield record({
              type: "feedback-loop",
              from: "review",
              to: "implementation",
              reason: `${findings.filter((f) => f.severity === "critical").length} critical finding(s)`,
            });
            // TODO: Loop back to implementation with findings as context
          }
        }
      } else if (phase === "verify") {
        // Verify phase runs build/test commands
        const buildResult = options.buildCommand
          ? await dispatcher.runCommand(
              options.buildCommand,
              options.projectPath,
            )
          : { passed: true, output: "" };
        const testResult = options.testCommand
          ? await dispatcher.runCommand(
              options.testCommand,
              options.projectPath,
            )
          : { passed: true, output: "" };

        result = {
          phase,
          agentId: config.agentId,
          output: `Build: ${buildResult.passed ? "PASS" : "FAIL"}\nTests: ${testResult.passed ? "PASS" : "FAIL"}\n${buildResult.output}\n${testResult.output}`,
          cost: 0,
          toolCalls: [],
          duration: Date.now() - startTime,
          success: buildResult.passed && testResult.passed,
        };

        if (!result.success) {
          yield record({
            type: "feedback-loop",
            from: "verify",
            to: "implementation",
            reason: "Build or tests failed",
          });
        }
      } else {
        // Standard single-agent phase
        const agentResult = await dispatcher.runPhase(
          config.agentId,
          config.subagentType,
          prompt,
          { budget: budgetPerPhase, projectPath: options.projectPath },
        );

        result = {
          phase,
          agentId: config.agentId,
          output: agentResult.text,
          cost: agentResult.cost,
          toolCalls: agentResult.toolCalls,
          duration: Date.now() - startTime,
          success: true,
        };
      }

      // Capture outputs for downstream phases
      if (phase === "spec") specOutput = result.output;
      if (phase === "architecture") designOutput = result.output;
      if (phase === "implementation") implementationOutput = result.output;

      totalCost += result.cost;
      results.push(result);
      yield record({ type: "phase-completed", result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      yield record({ type: "phase-failed", phase, error });
      results.push({
        phase,
        agentId: config.agentId,
        output: "",
        cost: 0,
        toolCalls: [],
        duration: Date.now() - startTime,
        success: false,
        error,
      });
    }
  }

  yield record({ type: "pipeline-completed", results, totalCost });

  // Finalize trajectory — persists to disk as training data for BrainstormLLM v2
  const trajectory = recorder.finalize();
  // Log trajectory ID for linking to BR API
  if (trajectory.phases.length > 0) {
    console.error(
      `[trajectory] ${trajectory.id} — ${trajectory.phases.length} phases, $${trajectory.totalCost.toFixed(4)}, ${trajectory.totalDuration}ms`,
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildPhasePrompt(
  phase: PipelinePhase,
  request: string,
  context: { spec: string; design: string; implementation: string },
): string {
  switch (phase) {
    case "spec":
      return `Write a specification for the following request:\n\n${request}`;
    case "architecture":
      return `Design the technical implementation for this specification:\n\n${context.spec || request}`;
    case "implementation":
      return `Implement the following design:\n\n${context.design || context.spec || request}`;
    case "review":
      return `Review the code changes made for this task. Check for bugs, security issues, and style.\n\nOriginal request: ${request}\n\nSpec: ${context.spec?.slice(0, 500) || "N/A"}`;
    case "verify":
      return `Verify the build and tests pass.`;
    case "refactor":
      return `Review the recently implemented code and suggest refactoring improvements without changing behavior.`;
    case "deploy":
      return `Deploy the changes. Verify build first, then run deployment commands.`;
    case "document":
      return `Generate documentation for the changes made.\n\nSpec: ${context.spec?.slice(0, 500) || "N/A"}\nDesign: ${context.design?.slice(0, 500) || "N/A"}`;
    case "report":
      return `Produce an execution report summarizing what was accomplished, costs, findings, and next steps.\n\nOriginal request: ${request}`;
    default:
      return request;
  }
}

function parseReviewFindings(reviewOutput: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = reviewOutput.split("\n");

  for (const line of lines) {
    const criticalMatch = line.match(/\b(critical|CRITICAL)\b[:\s]+(.+)/i);
    if (criticalMatch) {
      findings.push({
        severity: "critical",
        description: criticalMatch[2].trim(),
        reviewer: "combined",
      });
    }

    const highMatch = line.match(/\b(high|HIGH)\b[:\s]+(.+)/i);
    if (highMatch && !criticalMatch) {
      findings.push({
        severity: "high",
        description: highMatch[2].trim(),
        reviewer: "combined",
      });
    }

    const medMatch = line.match(/\b(medium|MEDIUM)\b[:\s]+(.+)/i);
    if (medMatch && !criticalMatch && !highMatch) {
      findings.push({
        severity: "medium",
        description: medMatch[2].trim(),
        reviewer: "combined",
      });
    }
  }

  return findings;
}
