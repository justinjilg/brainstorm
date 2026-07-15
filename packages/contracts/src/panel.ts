// JudgePanel — decorrelated verification as a first-class primitive.
//
// N judges across distinct provider families and lenses review the SAME
// artifact in ISOLATION (Promise.allSettled; each judge sees only the
// contract render + the artifact, never another judge's verdict, never the
// producer's self-reported confidence) and a PURE aggregation function decides
// the outcome. The model spawn and the model pool are INJECTED so this package
// never imports core or router (no dependency cycle) — core wires the real
// spawnSubagent + BrainstormRouter.getModels at the call site.

import type { z } from "zod";
import { randomBytes } from "node:crypto";
import type {
  AgentContract,
  ModelEntry,
  CapabilityScores,
  PanelConfig,
  PanelJudgeSpec,
  PanelDecision,
  QuorumSpec,
  Verdict,
  ReviewFinding,
} from "@brainst0rm/shared";
import { renderContractPrompt } from "./contract.js";

// ── Capability scoring (mirrors router/team-optimizer's style) ───────────
//
// The panel selector is the inverted sibling of optimizeTeamComposition: the
// team optimizer picks the CHEAPEST model above a capability floor; the panel
// selector picks models above a capability floor that MAXIMIZE distinct
// provider families. We reuse the same capabilityScores-average scoring style
// but take `models` as a parameter (never import router) — the dimensions that
// matter for a JUDGE are reasoning / instruction-following / self-correction.

const JUDGE_CAPABILITY_DIMS: (keyof CapabilityScores)[] = [
  "multiStepReasoning",
  "instructionFollowing",
  "selfCorrection",
];

/** Minimum capability score for a model to be eligible as a judge. */
export const DEFAULT_JUDGE_CAPABILITY_FLOOR = 0.6;

/** Average a model's judge-relevant capability dimensions (0-1). Models with no
 * scored profile get a neutral 0.5 so they are not silently excluded. */
export function scoreJudgeCapability(model: ModelEntry): number {
  const scores = model.capabilities.capabilityScores;
  if (!scores) return 0.5;
  const dims = JUDGE_CAPABILITY_DIMS.map((d) => scores[d] ?? 0.5);
  return dims.reduce((s, v) => s + v, 0) / dims.length;
}

// ── Diverse-judge selection ──────────────────────────────────────────────

export interface DiversitySelectionConfig {
  /** provider = maximize distinct provider families (default); model = maximize
   * distinct models; none = simply take the top-N by capability. */
  diversity: "provider" | "model" | "none";
  /** The author's model id (contract.provenance.producerModelId). The author's
   * FAMILY never reviews its own work when an alternative exists. */
  authorModelId?: string;
  /** Minimum capability score for eligibility. Default 0.6. */
  capabilityFloor?: number;
}

/** The achieved diversity level, recorded rather than silently pretended. */
export type AchievedDiversity =
  | "provider" // every judge is a distinct provider family
  | "model" // distinct models, but some providers repeat
  | "single-model"; // fewer distinct models than judges — lenses share a model

export interface DiverseJudgeSelection {
  judges: PanelJudgeSpec[];
  achievedDiversity: AchievedDiversity;
  providersUsed: string[];
  /** Human-readable explanation of any degradation. */
  note: string;
}

/**
 * Greedy provider-diverse judge selection over a model pool above a capability
 * floor. For each judge spec without a pinned model, pick a model that
 * MAXIMIZES distinct provider families; degrade EXPLICITLY when there are
 * fewer than N providers (distinct models → distinct lenses on one model) and
 * record the achieved diversity level.
 *
 * The author's provider family is excluded when an alternative exists (a
 * model must not review its own family's work when a different family is
 * available). Pinned specs (modelId already set) are honored as-is and count
 * their provider toward the seen set.
 *
 * Pure: no model calls, no I/O. Unit-testable exactly like team-optimizer.
 */
export function selectDiverseJudges(
  specs: PanelJudgeSpec[],
  models: ModelEntry[],
  config: DiversitySelectionConfig,
): DiverseJudgeSelection {
  const floor = config.capabilityFloor ?? DEFAULT_JUDGE_CAPABILITY_FLOOR;

  // Eligible = available + above the capability floor. If the floor excludes
  // everything, relax to all available (team-optimizer's fallback discipline).
  const available = models.filter((m) => m.status === "available");
  const scored = available.map((m) => ({ m, score: scoreJudgeCapability(m) }));
  let eligible = scored.filter((s) => s.score >= floor);
  if (eligible.length === 0) eligible = scored;

  // Deterministic ranking: capability desc, then cheaper, then id for stability.
  eligible.sort(
    (a, b) =>
      b.score - a.score ||
      a.m.pricing.outputPer1MTokens - b.m.pricing.outputPer1MTokens ||
      a.m.id.localeCompare(b.m.id),
  );

  const authorProvider = config.authorModelId
    ? available.find((m) => m.id === config.authorModelId)?.provider
    : undefined;

  // Prefer non-author-family models; keep author-family as a last resort so a
  // panel is never starved when the author's family is the only option.
  const preferred =
    authorProvider !== undefined
      ? eligible.filter((s) => s.m.provider !== authorProvider)
      : eligible;
  const pool = preferred.length > 0 ? preferred : eligible;

  const seenProviders = new Set<string>();
  const seenModels = new Set<string>();
  const out: PanelJudgeSpec[] = [];

  // Account for pinned specs up front so the greedy pass diversifies AROUND
  // them.
  for (const spec of specs) {
    if (spec.modelId) {
      const provider = available.find((m) => m.id === spec.modelId)?.provider;
      if (provider) seenProviders.add(provider);
      seenModels.add(spec.modelId);
    }
  }

  for (const spec of specs) {
    if (spec.modelId) {
      out.push({ ...spec });
      continue;
    }

    const pick = pickNextModel(
      pool.map((s) => s.m),
      config.diversity,
      seenProviders,
      seenModels,
    );
    if (!pick) {
      // No model at all (empty pool) — leave the spec unresolved. The panel
      // runner records this judge as errored (excluded from the quorum
      // denominator) rather than silently inventing a model.
      out.push({ ...spec });
      continue;
    }
    seenProviders.add(pick.provider);
    seenModels.add(pick.id);
    out.push({ ...spec, modelId: pick.id });
  }

  // Compute the achieved diversity from what was actually assigned.
  const assigned = out.filter((j) => j.modelId);
  const providersUsed = assigned
    .map((j) => available.find((m) => m.id === j.modelId)?.provider)
    .filter((p): p is string => Boolean(p));
  const distinctProviders = new Set(providersUsed).size;
  const distinctModels = new Set(assigned.map((j) => j.modelId)).size;

  let achievedDiversity: AchievedDiversity;
  let note: string;
  if (assigned.length > 0 && distinctProviders === assigned.length) {
    achievedDiversity = "provider";
    note = `${distinctProviders} distinct provider families`;
  } else if (assigned.length > 0 && distinctModels === assigned.length) {
    achievedDiversity = "model";
    note = `only ${distinctProviders} provider family(ies) available — degraded to ${distinctModels} distinct models (decorrelation reduced)`;
  } else {
    achievedDiversity = "single-model";
    note = `insufficient model diversity — ${distinctModels} distinct model(s) across ${assigned.length} judges; lenses share a model (distinct lenses on one model)`;
  }

  return {
    judges: out,
    achievedDiversity,
    providersUsed: [...new Set(providersUsed)],
    note,
  };
}

/** Pick the highest-ranked model preferring an unseen provider (or unseen
 * model when diversity is 'model'); fall back to an unseen model, then to any
 * model (lens sharing). `models` is already ranked best-first. */
function pickNextModel(
  models: ModelEntry[],
  diversity: DiversitySelectionConfig["diversity"],
  seenProviders: Set<string>,
  seenModels: Set<string>,
): ModelEntry | undefined {
  if (models.length === 0) return undefined;

  if (diversity === "provider") {
    const unseenProvider = models.find((m) => !seenProviders.has(m.provider));
    if (unseenProvider) return unseenProvider;
  }
  if (diversity !== "none") {
    const unseenModel = models.find((m) => !seenModels.has(m.id));
    if (unseenModel) return unseenModel;
  }
  // 'none', or everything already seen: take the best-ranked unseen model if
  // any, else the best overall (lens sharing).
  return models.find((m) => !seenModels.has(m.id)) ?? models[0];
}

// ── Aggregation (pure, shaped like decideJudgeOutcome) ────────────────────

/**
 * Decide a panel's outcome from its verdicts. PURE — deliberately shaped like
 * decideJudgeOutcome so its precedence is unit-testable without any model.
 *
 * Precedence:
 *   1. veto-lens fail → reject (a security lens can veto alone)
 *   1b. a veto-lens that was ATTEMPTED but produced no valid verdict (its only
 *       verdict(s) errored) → revise (the safety gate could not be evaluated —
 *       an errored security judge must NOT silently nullify the veto and let an
 *       otherwise-passing panel approve)
 *   2. no usable verdict → revise (nothing was verified)
 *   3. >half the panel errored → revise (insufficient verification ≠ approval)
 *   4. quorum of passes met → approve
 *   5. quorum failed, a critical finding among the failures → reject
 *   6. otherwise → revise (revise-able failures)
 *
 * Errored judges shrink the denominator (they are excluded from the pass
 * fraction) but are counted for the >half-errored guard.
 *
 * The returned `quorum` snapshot always reflects the actual deciding rule, so a
 * persisted PanelDecision never shows a "met" tally alongside a non-approve
 * decision (e.g. the >half-errored or veto overrides).
 */
export function decidePanelOutcome(
  verdicts: Verdict[],
  quorum: QuorumSpec,
): {
  decision: "approve" | "revise" | "reject";
  reason: string;
  quorum: { required: number; achieved: number; rule: string };
} {
  const total = verdicts.length;
  const valid = verdicts.filter((v) => !v.error);
  const errored = verdicts.filter((v) => v.error);
  const passes = valid.filter((v) => v.pass).length;

  // 1) Veto: a failing veto-lens is definitive, even if others errored.
  if (quorum.kind === "unanimous-veto") {
    const vetoLenses = new Set(quorum.vetoLenses);
    const vetoFail = valid.find((v) => vetoLenses.has(v.lens) && !v.pass);
    if (vetoFail) {
      return {
        decision: "reject",
        reason: `veto lens '${vetoFail.lens}' failed: ${vetoFail.rationale || "no rationale"}`,
        quorum: { required: 1, achieved: 0, rule: `veto:${vetoFail.lens}` },
      };
    }

    // 1b) A veto lens that WAS attempted (has a verdict) but produced no valid
    // (non-errored) verdict means that safety dimension could not be evaluated.
    // An errored security judge must not nullify the veto and let the rest of
    // the panel approve — insufficient security verification is not approval.
    // (A veto lens entirely ABSENT from the panel — e.g. 'build-test' when no
    // deterministic panelist is folded in — is simply not part of this run and
    // does not force a revise.)
    const erroredVetoLens = [...vetoLenses].find(
      (lens) =>
        verdicts.some((v) => v.lens === lens) &&
        !valid.some((v) => v.lens === lens),
    );
    if (erroredVetoLens) {
      return {
        decision: "revise",
        reason: `veto lens '${erroredVetoLens}' errored — its verdict is unavailable, so the safety gate could not be evaluated (insufficient verification, not an approval)`,
        quorum: { required: 1, achieved: 0, rule: `veto:${erroredVetoLens}` },
      };
    }
  }

  // 2) Nothing usable was verified.
  if (valid.length === 0) {
    return {
      decision: "revise",
      reason:
        total === 0
          ? "no judges ran — nothing to verify"
          : `all ${total} judge(s) errored — no usable verdict`,
      quorum: { required: 1, achieved: 0, rule: "no-verdicts" },
    };
  }

  // 3) Insufficient verification: more than half the panel failed to run.
  if (total > 0 && errored.length * 2 > total) {
    return {
      decision: "revise",
      reason: `${errored.length}/${total} judges errored — insufficient verification (not an approval)`,
      quorum: {
        required: Math.floor(total / 2) + 1,
        achieved: passes,
        rule: "insufficient-verification",
      },
    };
  }

  // 4) Quorum of passes.
  const { met, required, achieved, rule } = evaluateQuorum(valid, quorum);
  if (met) {
    return {
      decision: "approve",
      reason: `quorum met (${rule}): ${achieved} pass, ${required} required`,
      quorum: { required, achieved, rule },
    };
  }

  // 5/6) Quorum failed — reject on a critical finding, else revise.
  const critical = valid.some(
    (v) => !v.pass && v.findings.some((f) => f.severity === "critical"),
  );
  if (critical) {
    return {
      decision: "reject",
      reason: `quorum not met (${rule}) and a critical finding was raised`,
      quorum: { required, achieved, rule },
    };
  }
  return {
    decision: "revise",
    reason: `quorum not met (${rule}: ${achieved} pass, ${required} required) — revise-able failures`,
    quorum: { required, achieved, rule },
  };
}

/** Evaluate a quorum rule over the VALID verdicts (errored already excluded). */
function evaluateQuorum(
  valid: Verdict[],
  quorum: QuorumSpec,
): { met: boolean; required: number; achieved: number; rule: string } {
  const passes = valid.filter((v) => v.pass);
  switch (quorum.kind) {
    case "threshold": {
      const required = Math.ceil(quorum.passFraction * valid.length);
      return {
        met: passes.length >= required && required > 0,
        required,
        achieved: passes.length,
        rule: `threshold ${quorum.passFraction}`,
      };
    }
    case "weighted": {
      const totalWeight = valid.reduce((s, v) => s + weightOf(v), 0);
      const passWeight = passes.reduce((s, v) => s + weightOf(v), 0);
      const required = quorum.passWeightFraction * totalWeight;
      return {
        met: totalWeight > 0 && passWeight >= required,
        required: round2(required),
        achieved: round2(passWeight),
        rule: `weighted ${quorum.passWeightFraction}`,
      };
    }
    case "majority":
    case "unanimous-veto":
    default: {
      // unanimous-veto's base rule (after the veto check) is a simple majority
      // of the remaining valid judges — "majority + <veto> veto".
      const required = Math.floor(valid.length / 2) + 1;
      return {
        met: passes.length >= required,
        required,
        achieved: passes.length,
        rule: quorum.kind === "unanimous-veto" ? "majority+veto" : "majority",
      };
    }
  }
}

// Weight lives on the verdict's originating spec; the deterministic panelist is
// stamped with weight 2 (see runJudgePanel). Verdict has no weight field, so we
// carry it on a symbol-free convention: the panel runner attaches `_weight`.
function weightOf(v: Verdict & { _weight?: number }): number {
  return typeof v._weight === "number" ? v._weight : 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Lens prompts ──────────────────────────────────────────────────────────

const LENS_PROMPTS: Record<string, string> = {
  correctness:
    "You are a CORRECTNESS judge. Scrutinize the artifact for logic errors, " +
    "broken edge cases, incorrect control flow, off-by-one and boundary bugs, " +
    "and mismatches between the stated intent and the actual behavior. Assume " +
    "nothing works until you have traced it.",
  security:
    "You are a SECURITY judge. Look for injection (shell/SQL/path), unsafe " +
    "deserialization, secret leakage, missing authz/authn, unsafe defaults, " +
    "privilege escalation, and any widening of trust boundaries. You hold a " +
    "VETO: if you find a genuine security defect, fail the artifact.",
  performance:
    "You are a PERFORMANCE judge. Look for accidental quadratic behavior, " +
    "unbounded allocation, N+1 patterns, redundant work in hot paths, and " +
    "missing back-pressure. Distinguish real regressions from micro-noise.",
  reproducibility:
    "You are a REPRODUCIBILITY judge. Verify the change is deterministic, " +
    "does not depend on hidden global state, and that its claimed effects " +
    "would survive a clean re-run. Flag nondeterminism and hidden coupling.",
  "contract-fit":
    "You are a CONTRACT-FIT judge. Verify the artifact satisfies the stated " +
    "Intent, honors every Non-goal, produces the declared deliverable shape, " +
    "and meets each Acceptance criterion. Evaluate each acceptance criterion " +
    "explicitly and report a per-criterion result.",
};

/** Build the lens-specific system-prompt append for a judge. Falls back to a
 * generic reviewer instruction for unknown lenses. */
export function buildLensPrompt(lens: string): string {
  const base =
    LENS_PROMPTS[lens] ??
    `You are a ${lens.toUpperCase()} judge. Review the artifact strictly through the '${lens}' lens.`;
  return (
    `${base}\n\n` +
    "You are reviewing in ISOLATION: you do not see other judges' opinions or " +
    "the author's self-assessment. Judge only the contract and the artifact.\n\n" +
    "Respond with a SINGLE JSON object matching the `verdict` schema (fenced in " +
    "a ```json block): { pass, score, confidence, rationale, findings[], " +
    "criteriaResults[] }. `pass` is your verdict; `findings` lists concrete " +
    "defects with a severity of critical|high|medium|low."
  );
}

// ── Panel dispatch (injected spawn + model pool) ──────────────────────────

/** A single judge spawn request handed to the injected spawn function. */
export interface PanelSpawnRequest {
  /** The judge's task: the contract render (forJudge) + the artifact/diff. */
  task: string;
  /** Model to pin for this judge (from the diversity selector). */
  preferredModelId?: string;
  /** Lens system-prompt append. */
  promptAppend: string;
  /** Hard step ceiling for a judge (default 5). */
  maxSteps: number;
  /** Optional per-judge budget cap (budgetLimitUsd / N). */
  budgetLimit?: number;
}

/** The minimal result the injected spawn must return. */
export interface PanelSpawnResult {
  text: string;
  cost: number;
  modelUsed: string;
  /** Provider family of the model that actually ran (for decorrelation audit). */
  provider: string;
}

export type PanelSpawn = (req: PanelSpawnRequest) => Promise<PanelSpawnResult>;

/** Injected dependencies for runJudgePanel. Nothing model/core-specific is
 * imported by this package — it is all injected here. */
export interface PanelDeps {
  /** Spawn one isolated judge. Core wires the real spawnSubagent(type:'review'). */
  spawn: PanelSpawn;
  /** The model pool (BrainstormRouter.getModels()). */
  getModels: () => ModelEntry[];
  /** Resolver for the registered `verdict` Zod schema (agents OUTPUT_SCHEMAS). */
  getOutputSchema: (name: string) => z.ZodType | undefined;
  /** Optional deterministic (build/test) verdict folded in as a weight-2
   * panelist — this is how the panel GENERALIZES today's single judge. */
  deterministicVerdict?: Verdict;
  /** Optional ids for the returned decision / audit. */
  panelId?: string;
  /** Optional capability floor override. */
  capabilityFloor?: number;
}

/**
 * Run a panel of diverse judges over an artifact against a contract. Judges run
 * in PARALLEL and ISOLATED (Promise.allSettled) — each sees ONLY
 * renderContractPrompt(contract, { forJudge: true }) + the artifact, never
 * another judge's verdict and never the producer's confidence. Aggregates via
 * decidePanelOutcome. Persists NOTHING (the caller persists).
 */
export async function runJudgePanel(
  contract: AgentContract,
  artifact: string,
  config: PanelConfig,
  deps: PanelDeps,
): Promise<PanelDecision> {
  const panelId = deps.panelId ?? `pn_${ulidish()}`;
  const models = deps.getModels();

  const selection = selectDiverseJudges(config.judges, models, {
    diversity: config.diversity,
    authorModelId: contract.provenance.producerModelId,
    capabilityFloor: deps.capabilityFloor,
  });

  const contractRender = renderContractPrompt(contract, { forJudge: true });
  const verdictSchema = deps.getOutputSchema("verdict");
  const perJudgeBudget =
    config.budgetLimitUsd && selection.judges.length > 0
      ? config.budgetLimitUsd / selection.judges.length
      : undefined;

  const settled = await Promise.allSettled(
    selection.judges.map((spec) =>
      runOneJudge(spec, {
        artifact,
        contractRender,
        verdictSchema,
        spawn: deps.spawn,
        maxSteps: 5,
        budgetLimit: perJudgeBudget,
        modelProvider: (id) => models.find((m) => m.id === id)?.provider,
      }),
    ),
  );

  const verdicts: (Verdict & { _weight?: number })[] = settled.map((s, idx) => {
    if (s.status === "fulfilled") return s.value;
    // A rejected spawn is an errored judge (excluded from the pass
    // denominator, counted for the >half-errored guard).
    const spec = selection.judges[idx];
    return erroredVerdict(
      spec,
      s.reason instanceof Error ? s.reason.message : String(s.reason),
    );
  });

  // Fold the deterministic build/test verdict in as a weight-2 panelist.
  if (config.includeDeterministic && deps.deterministicVerdict) {
    verdicts.push({ ...deps.deterministicVerdict, _weight: 2 });
  }

  const { decision, reason, quorum } = decidePanelOutcome(
    verdicts,
    config.quorum,
  );

  // Dissent = rationales of judges on the losing side of the decision.
  const dissent = verdicts
    .filter((v) => !v.error && v.pass !== (decision === "approve"))
    .map((v) => `${v.judgeId}: ${v.rationale || "(no rationale)"}`);

  const totalCost = verdicts.reduce((s, v) => s + (v.cost ?? 0), 0);

  return {
    panelId,
    decision,
    verdicts: verdicts.map(stripWeight),
    quorum,
    dissent,
    combinedRationale: buildCombinedRationale(
      decision,
      reason,
      verdicts,
      selection,
    ),
    totalCost,
  };
}

interface OneJudgeDeps {
  artifact: string;
  contractRender: string;
  verdictSchema: z.ZodType | undefined;
  spawn: PanelSpawn;
  maxSteps: number;
  budgetLimit?: number;
  modelProvider: (id: string) => string | undefined;
}

async function runOneJudge(
  spec: PanelJudgeSpec,
  d: OneJudgeDeps,
): Promise<Verdict & { _weight?: number }> {
  if (!spec.modelId) {
    // The selector could not assign a model (empty pool) — surface as errored.
    return erroredVerdict(spec, "no model available for this judge");
  }

  const startedAt = Date.now();
  const task =
    `${d.contractRender}\n\n## Artifact under review\n\n${d.artifact}\n\n` +
    "Emit your verdict now as a single JSON object.";

  const result = await d.spawn({
    task,
    preferredModelId: spec.modelId,
    promptAppend: buildLensPrompt(spec.lens),
    maxSteps: d.maxSteps,
    budgetLimit: d.budgetLimit,
  });

  const durationMs = Date.now() - startedAt;
  const provider =
    result.provider || d.modelProvider(spec.modelId) || "unknown";

  const parsed = parseVerdictOutput(result.text, d.verdictSchema);
  if (!parsed.ok) {
    return {
      judgeId: `${spec.lens}:${spec.modelId}`,
      lens: spec.lens,
      modelId: spec.modelId,
      provider,
      pass: false,
      confidence: 0,
      rationale: `verdict parse failed: ${parsed.error}`,
      findings: [],
      cost: result.cost,
      durationMs,
      error: `unparseable verdict: ${parsed.error}`,
      _weight: spec.weight,
    };
  }

  const v = parsed.value;
  const findings: ReviewFinding[] = (v.findings ?? []).map((f) => ({
    severity: f.severity,
    description: f.description,
    file: f.file,
    line: f.line,
    reviewer: `${spec.lens}:${spec.modelId}`,
  }));

  return {
    judgeId: `${spec.lens}:${spec.modelId}`,
    lens: spec.lens,
    modelId: spec.modelId,
    provider,
    pass: v.pass,
    score: v.score,
    confidence: v.confidence,
    rationale: v.rationale,
    findings,
    criteriaResults: v.criteriaResults,
    cost: result.cost,
    durationMs,
    _weight: spec.weight,
  };
}

interface ParsedVerdict {
  pass: boolean;
  score?: number;
  confidence: number;
  rationale: string;
  findings?: {
    severity: "critical" | "high" | "medium" | "low";
    description: string;
    file?: string;
    line?: number;
  }[];
  criteriaResults?: { criterion: string; pass: boolean; evidence?: string }[];
}

function parseVerdictOutput(
  rawText: string,
  schema: z.ZodType | undefined,
): { ok: true; value: ParsedVerdict } | { ok: false; error: string } {
  const block = extractJson(rawText);
  if (block === undefined) return { ok: false, error: "no JSON block found" };
  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (schema) {
    const r = schema.safeParse(json);
    if (!r.success) {
      return {
        ok: false,
        error: r.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      };
    }
    return { ok: true, value: r.data as ParsedVerdict };
  }
  return { ok: true, value: json as ParsedVerdict };
}

/** Local JSON extractor (kept independent of contract.ts's export surface). */
function extractJson(rawText: string): string | undefined {
  const fence = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  const start = rawText.search(/[[{]/);
  if (start === -1) return undefined;
  const open = rawText[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return rawText.slice(start, i + 1);
    }
  }
  return undefined;
}

function erroredVerdict(
  spec: PanelJudgeSpec,
  error: string,
): Verdict & { _weight?: number } {
  return {
    judgeId: `${spec.lens}:${spec.modelId ?? "unassigned"}`,
    lens: spec.lens,
    modelId: spec.modelId ?? "unassigned",
    provider: "unknown",
    pass: false,
    confidence: 0,
    rationale: "",
    findings: [],
    cost: 0,
    durationMs: 0,
    error,
    _weight: spec.weight,
  };
}

function stripWeight(v: Verdict & { _weight?: number }): Verdict {
  const { _weight, ...rest } = v;
  return rest;
}

function buildCombinedRationale(
  decision: string,
  reason: string,
  verdicts: Verdict[],
  selection: DiverseJudgeSelection,
): string {
  const valid = verdicts.filter((v) => !v.error);
  const pass = valid.filter((v) => v.pass).length;
  const errored = verdicts.length - valid.length;
  const lines: string[] = [];
  lines.push(`Decision: ${decision.toUpperCase()} — ${reason}`);
  lines.push(
    `Tally: ${pass}/${valid.length} passed` +
      (errored > 0 ? `, ${errored} errored` : "") +
      ` | diversity: ${selection.achievedDiversity} (${selection.note})`,
  );
  const topFindings = valid
    .flatMap((v) => v.findings)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 5);
  if (topFindings.length > 0) {
    lines.push("Top findings:");
    for (const f of topFindings) {
      lines.push(
        `  [${f.severity}] ${f.description}${f.file ? ` (${f.file})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function severityRank(s: ReviewFinding["severity"]): number {
  return { critical: 3, high: 2, medium: 1, low: 0 }[s] ?? 0;
}

function ulidish(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

// ── Default panels ────────────────────────────────────────────────────────

/**
 * Built-in panel configs encoding the cost/blast-radius guidance:
 *   - `deterministic`: build/test only (no LLM judges) — exactly today's
 *     single-judge behavior. `judges: []` + `includeDeterministic` degenerates
 *     to the deterministic verdict alone.
 *   - `merge-gate`: 3 provider-diverse LLM judges (correctness/security/
 *     contract-fit) plus the deterministic panelist, aggregated by majority
 *     with a security veto. Reserved for autoMerge / authority-boundary gates.
 */
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  deterministic: {
    judges: [],
    diversity: "none",
    quorum: { kind: "majority" },
    includeDeterministic: true,
  },
  "merge-gate": {
    judges: [
      { lens: "correctness" },
      { lens: "security" },
      { lens: "contract-fit" },
    ],
    diversity: "provider",
    // security can veto a merge alone; build-test veto keeps the deterministic
    // panelist ungameable — a failed build/test cannot be out-voted by lenient
    // LLM judges (LLM judges are systematically lenient; deterministic is not).
    quorum: {
      kind: "unanimous-veto",
      vetoLenses: ["security", "build-test"],
    },
    includeDeterministic: true,
    budgetLimitUsd: 1,
  },
};
