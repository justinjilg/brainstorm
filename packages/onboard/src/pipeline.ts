/**
 * Onboard Pipeline — async generator that orchestrates all phases.
 *
 * Same pattern as DaemonController and runOrchestrationPipeline:
 * yields OnboardEvents for real-time CLI rendering.
 *
 * Each phase enriches the OnboardContext. LLM phases check the
 * budget tracker before running and skip if over budget.
 * Phase 0 (static) and Phase 6 (verification) always run.
 */

import { createLogger } from "@brainst0rm/shared";
import {
  type OnboardOptions,
  type OnboardEvent,
  type OnboardContext,
  type OnboardResult,
  type OnboardPhase,
  type OnboardDispatcher,
  ALL_PHASES,
  PHASE_LABELS,
} from "./types.js";
import {
  inferBudget,
  createBudgetTracker,
  PHASE_COST_ESTIMATES,
  type BudgetTracker,
} from "./budget.js";
import { runStaticAnalysis } from "./phases/static-analysis.js";
import { runCodeGraphBuild } from "./phases/code-graph-build.js";
import { runVerification } from "./phases/verification.js";
import { runDeepExploration } from "./phases/deep-exploration.js";
import { runTeamAssembly } from "./phases/team-assembly.js";
import { runRoutingRules } from "./phases/routing-rules.js";
import { runWorkflowGen } from "./phases/workflow-gen.js";
import { runBrainstormMd } from "./phases/brainstorm-md.js";

const log = createLogger("onboard");

/** Phases that require LLM calls (and therefore budget). */
const LLM_PHASES: OnboardPhase[] = [
  "deep-exploration",
  "team-assembly",
  "routing-rules",
  "workflow-gen",
  "brainstorm-md",
];

/**
 * Run the full onboard pipeline.
 *
 * Yields OnboardEvents as phases progress. The caller (CLI)
 * iterates this generator and renders each event.
 */
export async function* runOnboardPipeline(
  options: OnboardOptions,
  dispatcher?: OnboardDispatcher,
): AsyncGenerator<OnboardEvent> {
  const startTime = Date.now();
  const phases = options.phases ?? ALL_PHASES;
  const filesWritten: string[] = [];
  const phasesRun: OnboardPhase[] = [];
  const phasesSkipped: OnboardPhase[] = [];

  // ── Phase 0: Static Analysis (always runs) ─────────────────────

  let context: OnboardContext | null = null;
  let budget: BudgetTracker | null = null;

  if (phases.includes("static-analysis")) {
    const phaseStart = Date.now();
    yield {
      type: "phase-started",
      phase: "static-analysis",
      description: "Analyzing codebase structure",
    };

    try {
      const { analysis, gitSummary } = runStaticAnalysis(options.projectPath);
      context = { analysis };

      // Store gitSummary on context for Phase 1 to use
      (context as any)._gitSummary = gitSummary;

      // Infer budget from analysis
      const totalBudget = options.budget ?? inferBudget(analysis);
      budget = createBudgetTracker(totalBudget);

      const summary = [
        `${analysis.summary.totalFiles} files`,
        `${analysis.summary.totalLines.toLocaleString()} lines`,
        `${analysis.summary.moduleCount} modules`,
        analysis.summary.primaryLanguage,
        ...analysis.summary.frameworkList.slice(0, 3),
      ].join(", ");

      phasesRun.push("static-analysis");
      yield {
        type: "phase-completed",
        phase: "static-analysis",
        cost: 0,
        durationMs: Date.now() - phaseStart,
        summary,
      };
    } catch (error) {
      yield {
        type: "phase-failed",
        phase: "static-analysis",
        error: error instanceof Error ? error.message : String(error),
      };
      return;
    }
  }

  if (!context) {
    yield {
      type: "phase-failed",
      phase: "static-analysis",
      error: "Static analysis is required but was not included in phases",
    };
    return;
  }

  if (!budget) {
    budget = createBudgetTracker(options.budget ?? 5.0);
  }

  // ── Phase 0.5: Code Graph Build (deterministic, zero cost) ─────────
  // Builds tree-sitter knowledge graph at ~/.brainstorm/projects/<hash>/code-graph.db
  // so the agent has structural query tools (code_callers, code_callees,
  // code_definition, code_impact) available the moment chat starts.
  if (phases.includes("code-graph-build")) {
    const phaseStart = Date.now();
    yield {
      type: "phase-started",
      phase: "code-graph-build",
      description: "Building tree-sitter knowledge graph",
    };

    try {
      const result = await runCodeGraphBuild(options.projectPath);
      // Stash on context so downstream phases / verification can reference it.
      (context as any)._codeGraph = result;
      phasesRun.push("code-graph-build");
      const summary = [
        `${result.stats.files} files`,
        `${result.stats.functions} functions`,
        `${result.stats.classes} classes`,
        `${result.stats.callEdges.toLocaleString()} call edges`,
      ].join(", ");
      yield {
        type: "phase-completed",
        phase: "code-graph-build",
        cost: 0,
        durationMs: Date.now() - phaseStart,
        summary,
      };
    } catch (error) {
      // Code graph is best-effort — failure shouldn't block the rest of
      // onboarding. Log and continue. The agent's code-graph tools will
      // gracefully report "not indexed" if no DB is found.
      yield {
        type: "phase-failed",
        phase: "code-graph-build",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Emit pipeline start with estimated budget
  const estimatedTotal = phases
    .filter((p) => LLM_PHASES.includes(p))
    .reduce((sum, p) => sum + (PHASE_COST_ESTIMATES[p] ?? 0), 0);

  yield {
    type: "onboard-started",
    options,
    estimatedBudget: Math.round(estimatedTotal * 100) / 100,
  };

  // ── LLM Phases (1-5) — skip if staticOnly or no dispatcher ────

  if (!options.staticOnly && dispatcher) {
    for (const phase of LLM_PHASES) {
      if (!phases.includes(phase)) continue;

      const estimate = PHASE_COST_ESTIMATES[phase] ?? 0;

      // Budget check
      if (estimate > 0 && !budget.canAfford(estimate)) {
        yield {
          type: "budget-warning",
          spent: budget.spent,
          remaining: budget.remaining,
        };
        yield {
          type: "phase-skipped",
          phase,
          reason: `Budget insufficient (need ~$${estimate.toFixed(2)}, have $${budget.remaining.toFixed(2)})`,
        };
        phasesSkipped.push(phase);
        continue;
      }

      // Dry run: show what would happen
      if (options.dryRun) {
        yield {
          type: "phase-skipped",
          phase,
          reason: `Dry run — would cost ~$${estimate.toFixed(2)}`,
        };
        phasesSkipped.push(phase);
        continue;
      }

      const phaseStart = Date.now();
      yield {
        type: "phase-started",
        phase,
        description: getPhaseDescription(phase),
      };

      try {
        const result = await runLLMPhase(phase, context, dispatcher);
        const cost = result.cost;
        budget.record(cost);

        // Merge result into context
        Object.assign(context, result.contextPatch);

        // Track written files
        if (result.filesWritten) {
          filesWritten.push(...result.filesWritten);
          for (const f of result.filesWritten) {
            yield { type: "file-written", path: f, description: phase };
          }
        }

        phasesRun.push(phase);
        yield {
          type: "phase-completed",
          phase,
          cost,
          durationMs: Date.now() - phaseStart,
          summary: result.summary,
        };
      } catch (error) {
        yield {
          type: "phase-failed",
          phase,
          error: error instanceof Error ? error.message : String(error),
        };
        // Continue to verification even if an LLM phase fails
        phasesSkipped.push(phase);
      }
    }
  } else {
    // Static-only mode or no dispatcher: skip all LLM phases
    for (const phase of LLM_PHASES) {
      if (!phases.includes(phase)) continue;
      yield {
        type: "phase-skipped",
        phase,
        reason: options.staticOnly
          ? "Static-only mode"
          : "No LLM dispatcher provided",
      };
      phasesSkipped.push(phase);
    }
  }

  // ── Phase 6: Verification (always runs) ────────────────────────

  if (phases.includes("verification")) {
    const phaseStart = Date.now();
    yield {
      type: "phase-started",
      phase: "verification",
      description: "Validating generated artifacts",
    };

    const verification = runVerification(context);
    context.verification = verification;
    phasesRun.push("verification");

    const counts: string[] = [];
    if (context.agents) {
      counts.push(
        `${context.agents.length} agents ${verification.agentsValid ? "valid" : "INVALID"}`,
      );
    }
    if (context.routingRules) {
      counts.push(
        `${context.routingRules.length} rules ${verification.routingValid ? "valid" : "INVALID"}`,
      );
    }
    if (context.recipes) {
      counts.push(
        `${context.recipes.length} recipes ${verification.recipesValid ? "valid" : "INVALID"}`,
      );
    }
    if (context.brainstormMd) {
      counts.push(
        `BRAINSTORM.md ${verification.brainstormMdValid ? "valid" : "INVALID"}`,
      );
    }

    yield {
      type: "phase-completed",
      phase: "verification",
      cost: 0,
      durationMs: Date.now() - phaseStart,
      summary: counts.join(", ") || "No artifacts to verify",
    };
  }

  // ── Result ─────────────────────────────────────────────────────

  yield {
    type: "onboard-completed",
    result: {
      context,
      filesWritten,
      totalCost: budget.spent,
      totalDurationMs: Date.now() - startTime,
      phasesRun,
      phasesSkipped,
    },
  };
}

// ── Phase Dispatch ─────────────────────────────────────────────────

interface PhaseRunResult {
  contextPatch: Partial<OnboardContext>;
  cost: number;
  summary: string;
  filesWritten?: string[];
}

/**
 * Dispatch to the appropriate LLM phase implementation.
 */
async function runLLMPhase(
  phase: OnboardPhase,
  context: OnboardContext,
  dispatcher: OnboardDispatcher,
): Promise<PhaseRunResult> {
  switch (phase) {
    case "deep-exploration":
      return runDeepExploration(context, dispatcher);
    case "team-assembly":
      return runTeamAssembly(context, dispatcher);
    case "routing-rules":
      return runRoutingRules(context, dispatcher);
    case "workflow-gen":
      return runWorkflowGen(context, dispatcher);
    case "brainstorm-md":
      return runBrainstormMd(context, dispatcher);
    default:
      throw new Error(`Unknown LLM phase: ${phase}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function getPhaseDescription(phase: OnboardPhase): string {
  switch (phase) {
    case "deep-exploration":
      return "Reading key files, discovering conventions and domain concepts";
    case "team-assembly":
      return "Generating specialized agents with project-specific knowledge";
    case "routing-rules":
      return "Creating task-to-agent routing rules";
    case "workflow-gen":
      return "Building project-specific workflow recipes";
    case "brainstorm-md":
      return "Generating enhanced BRAINSTORM.md with real conventions";
    default:
      return PHASE_LABELS[phase] ?? phase;
  }
}
