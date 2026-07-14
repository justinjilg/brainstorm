import { execFileSync } from "node:child_process";
import { relative, isAbsolute } from "node:path";
import type { z } from "zod";
import type { AgentContract, AcceptanceGate } from "@brainst0rm/shared";
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
