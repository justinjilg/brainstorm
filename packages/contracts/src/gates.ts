import { execFileSync } from "node:child_process";
import { relative, isAbsolute } from "node:path";
import type { z } from "zod";
import type {
  AgentContract,
  AcceptanceGate,
  PanelConfig,
  PanelDecision,
} from "@brainst0rm/shared";
import { validateContractOutput } from "./contract.js";

/** The outcome of evaluating a single acceptance gate. */
export interface GateResult {
  kind: AcceptanceGate["kind"];
  /** true = passed, false = failed, null = deferred (not evaluated here). */
  pass: boolean | null;
  detail: string;
  /** Set when this gate kind is a stage-2 concern (panel/criterion) and was
   * intentionally not evaluated by the deterministic runner. */
  deferred?: boolean;
}

/** Aggregate report over all of a contract's acceptance gates. */
export interface GateReport {
  /** True when every APPLICABLE (non-deferred) gate passed. Deferred gates do
   * not count against ok — they are evaluated elsewhere (the panel). */
  ok: boolean;
  gates: GateResult[];
}

/** The execution result a contract's gates are evaluated against. */
export interface ContractResult {
  /** Raw model output — used by the schema gate. */
  rawText?: string;
  /** Files the execution modified — used by the files_touched_within gate. */
  filesTouched?: string[];
}

/** Injected dependencies for the deterministic gate runner. */
export interface GateDeps {
  /** Resolver for output.schemaRef (injected to avoid a contracts→agents
   * hard dependency at the schema-registry level). */
  getOutputSchema: (name: string) => z.ZodType | undefined;
  /** Working directory for command gates (e.g. the task's worktree path). */
  cwd?: string;
}

/**
 * Run the DETERMINISTIC acceptance gates (schema / command / files_touched)
 * against an execution result. Panel and NL-criterion gates are stage-2
 * concerns — they are returned as clearly-marked deferred results and never
 * dispatched here (no model calls in this package).
 *
 * Command gates reuse the execFileSync + tight-timeout pattern from
 * verifyWorktree: the cmd string is tokenized on whitespace and executed
 * without a shell, so there is no shell-injection surface.
 */
export function runAcceptanceGates(
  contract: AgentContract,
  result: ContractResult,
  deps: GateDeps,
): GateReport {
  const gates: GateResult[] = [];

  for (const gate of contract.acceptance) {
    switch (gate.kind) {
      case "schema":
        gates.push(evalSchemaGate(contract, result, deps));
        break;
      case "command":
        gates.push(evalCommandGate(gate, deps));
        break;
      case "files_touched_within":
        gates.push(evalFilesTouchedGate(gate, result));
        break;
      case "panel":
        gates.push({
          kind: "panel",
          pass: null,
          deferred: true,
          detail:
            "panel gate deferred — dispatched by the JudgePanel (stage 2), not the deterministic runner",
        });
        break;
      case "criterion":
        gates.push({
          kind: "criterion",
          pass: null,
          deferred: true,
          detail:
            "NL criterion deferred — evaluated by the JudgePanel (stage 2), not by regex",
        });
        break;
      default:
        // Exhaustiveness guard for future gate kinds.
        gates.push({
          kind: (gate as AcceptanceGate).kind,
          pass: null,
          deferred: true,
          detail: "unknown gate kind — deferred",
        });
    }
  }

  const ok = gates.every((g) => g.deferred || g.pass === true);
  return { ok, gates };
}

// ── Async gate runner (panel + criterion kinds) ──────────────────────

/** Injected panel runner + artifact for the async gate runner. When present,
 * `panel` gates are dispatched (runJudgePanel) and `criterion` gates are
 * evaluated BY the panel (against the aggregated per-criterion results). */
export interface AsyncGateDeps extends GateDeps {
  /** Runs a panel against the contract + artifact. Injected by core (wraps
   * runJudgePanel with the real spawn + model pool) so this package never
   * imports core/router. */
  runPanel?: (
    config: PanelConfig,
    ctx: { contract: AgentContract; artifact: string },
  ) => Promise<PanelDecision>;
  /** Resolve a panelConfigRef (e.g. "merge-gate") to a PanelConfig. */
  resolvePanel?: (ref?: string) => PanelConfig | undefined;
  /** The artifact/diff the panel reviews. */
  artifact?: string;
}

/** A GateReport augmented with the panel decision (when a panel gate ran). */
export interface AsyncGateReport extends GateReport {
  panelDecision?: PanelDecision;
}

/**
 * Run ALL acceptance gates including the panel and criterion kinds. Deterministic
 * gates (schema/command/files_touched_within) are evaluated exactly as the sync
 * runner does; `panel` gates dispatch the injected panel runner and pass iff the
 * PanelDecision approves; `criterion` gates are evaluated BY the panel — a
 * criterion passes when the panel ran and the matching per-criterion result
 * passed (or, absent a per-criterion result, when the panel approved).
 *
 * Additive: the sync `runAcceptanceGates` is unchanged and still DEFERS
 * panel/criterion. Callers that want panel evaluation opt into this async form
 * and inject `runPanel`.
 */
export async function runAcceptanceGatesAsync(
  contract: AgentContract,
  result: ContractResult,
  deps: AsyncGateDeps,
): Promise<AsyncGateReport> {
  const gates: GateResult[] = [];
  let panelDecision: PanelDecision | undefined;

  for (const gate of contract.acceptance) {
    switch (gate.kind) {
      case "schema":
        gates.push(evalSchemaGate(contract, result, deps));
        break;
      case "command":
        gates.push(evalCommandGate(gate, deps));
        break;
      case "files_touched_within":
        gates.push(evalFilesTouchedGate(gate, result));
        break;
      case "panel": {
        if (!deps.runPanel || deps.artifact === undefined) {
          gates.push(deferredGate("panel", "no panel runner injected"));
          break;
        }
        const config =
          deps.resolvePanel?.(gate.panelConfigRef) ??
          (gate.quorum
            ? {
                judges: [],
                diversity: "provider" as const,
                quorum: gate.quorum,
                includeDeterministic: true,
              }
            : undefined);
        if (!config) {
          gates.push(
            deferredGate(
              "panel",
              `panel config '${gate.panelConfigRef ?? "(none)"}' could not be resolved`,
            ),
          );
          break;
        }
        panelDecision = await deps.runPanel(config, {
          contract,
          artifact: deps.artifact,
        });
        gates.push({
          kind: "panel",
          pass: panelDecision.decision === "approve",
          detail: `panel ${panelDecision.decision}: ${panelDecision.combinedRationale.split("\n")[0]}`,
        });
        break;
      }
      case "criterion":
        gates.push(evalCriterionGate(gate, panelDecision));
        break;
      default:
        gates.push(
          deferredGate((gate as AcceptanceGate).kind, "unknown gate kind"),
        );
    }
  }

  const ok = gates.every((g) => g.deferred || g.pass === true);
  return { ok, gates, panelDecision };
}

function deferredGate(
  kind: AcceptanceGate["kind"],
  detail: string,
): GateResult {
  return { kind, pass: null, deferred: true, detail };
}

/** Evaluate an NL criterion against the panel's per-criterion results. A
 * criterion the panel scored is authoritative; absent an explicit per-criterion
 * result, fall back to the panel's overall approval; absent a panel, defer. */
function evalCriterionGate(
  gate: Extract<AcceptanceGate, { kind: "criterion" }>,
  panelDecision: PanelDecision | undefined,
): GateResult {
  if (!panelDecision) {
    return deferredGate(
      "criterion",
      "no panel ran — NL criterion left for the panel (stage 2)",
    );
  }
  // Look for a judge that evaluated this exact criterion.
  const results = panelDecision.verdicts
    .flatMap((v) => v.criteriaResults ?? [])
    .filter((c) => c.criterion.trim() === gate.text.trim());
  if (results.length > 0) {
    // Criterion passes iff a majority of judges that scored it passed it.
    const passes = results.filter((c) => c.pass).length;
    const pass = passes * 2 >= results.length;
    return {
      kind: "criterion",
      pass,
      detail: `criterion "${gate.text.slice(0, 60)}": ${passes}/${results.length} judges satisfied`,
    };
  }
  return {
    kind: "criterion",
    pass: panelDecision.decision === "approve",
    detail: `criterion "${gate.text.slice(0, 60)}": no per-criterion result — using panel decision (${panelDecision.decision})`,
  };
}

function evalSchemaGate(
  contract: AgentContract,
  result: ContractResult,
  deps: GateDeps,
): GateResult {
  if (!contract.output.schemaRef) {
    return {
      kind: "schema",
      pass: true,
      detail: "no output schema declared — trivially satisfied",
    };
  }
  const validation = validateContractOutput(
    contract,
    result.rawText ?? "",
    deps.getOutputSchema,
  );
  return {
    kind: "schema",
    pass: validation.ok,
    detail: validation.ok
      ? "output parsed against declared schema"
      : `schema validation failed: ${validation.errors.join("; ")}`,
  };
}

function evalCommandGate(
  gate: Extract<AcceptanceGate, { kind: "command" }>,
  deps: GateDeps,
): GateResult {
  const tokens = gate.cmd.trim().split(/\s+/);
  const [bin, ...args] = tokens;
  if (!bin) {
    return { kind: "command", pass: false, detail: "empty command" };
  }
  try {
    execFileSync(bin, args, {
      cwd: deps.cwd,
      timeout: gate.timeoutMs ?? 5 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      kind: "command",
      pass: true,
      detail: `command passed: ${gate.cmd}`,
    };
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? "";
    return {
      kind: "command",
      pass: false,
      detail: `command failed: ${gate.cmd}${stderr ? ` (${stderr.slice(-200)})` : ""}`,
    };
  }
}

function evalFilesTouchedGate(
  gate: Extract<AcceptanceGate, { kind: "files_touched_within" }>,
  result: ContractResult,
): GateResult {
  const touched = result.filesTouched ?? [];
  const outside = touched.filter((f) => !isWithinAny(f, gate.paths));
  if (outside.length === 0) {
    return {
      kind: "files_touched_within",
      pass: true,
      detail:
        touched.length === 0
          ? "no files touched"
          : `all ${touched.length} touched file(s) within allowed paths`,
    };
  }
  return {
    kind: "files_touched_within",
    pass: false,
    detail: `files touched outside allowed paths: ${outside.join(", ")}`,
  };
}

/** True when `file` is inside (or equal to) at least one of `allowed`. */
function isWithinAny(file: string, allowed: string[]): boolean {
  return allowed.some((base) => isWithin(file, base));
}

function isWithin(file: string, base: string): boolean {
  // Directory-prefix containment that is not fooled by string prefixes
  // (e.g. "src/a" is NOT within "src/ab"). Uses path.relative: a path is
  // within base iff the relative path does not escape upward or become
  // absolute.
  if (file === base) return true;
  const rel = relative(base, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
