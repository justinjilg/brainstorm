import { z } from "zod";
import { randomBytes } from "node:crypto";
import type {
  AgentContract,
  AcceptanceGate,
  PriorAttemptFeedback,
} from "@brainst0rm/shared";

// ── Zod validation ───────────────────────────────────────────────────

const quorumSchema = z.union([
  z.object({ kind: z.literal("majority") }),
  z.object({ kind: z.literal("threshold"), passFraction: z.number() }),
  z.object({ kind: z.literal("weighted"), passWeightFraction: z.number() }),
  z.object({
    kind: z.literal("unanimous-veto"),
    vetoLenses: z.array(z.string()),
  }),
]);

const acceptanceGateSchema: z.ZodType<AcceptanceGate> = z.union([
  z.object({ kind: z.literal("schema") }),
  z.object({
    kind: z.literal("command"),
    cmd: z.string().min(1, "command gate requires a non-empty cmd"),
    timeoutMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("files_touched_within"),
    paths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("panel"),
    panelConfigRef: z.string().optional(),
    quorum: quorumSchema.optional(),
  }),
  z.object({ kind: z.literal("criterion"), text: z.string().min(1) }),
]) as z.ZodType<AcceptanceGate>;

/**
 * Zod schema validating an AgentContract. Rejects an empty intent — a lazy
 * contract with no rationale defeats the entire point of the layer (the WHY is
 * the piece that is lost first in freeform handoffs).
 */
export const AgentContractSchema: z.ZodType<AgentContract> = z.object({
  id: z.string().min(1),
  version: z.literal(1),
  intent: z.string().trim().min(1, "contract intent must not be empty"),
  context: z.string(),
  nonGoals: z.array(z.string()).optional(),
  inputs: z.object({
    task: z.string().min(1, "contract inputs.task must not be empty"),
    artifacts: z.array(z.string()).optional(),
    inputSchemaRef: z.string().optional(),
    inputData: z.unknown().optional(),
  }),
  output: z.object({
    schemaRef: z.string().optional(),
    inlineSchemaJson: z.string().optional(),
    contentType: z.enum(["json", "text", "code", "markdown"]),
  }),
  acceptance: z.array(acceptanceGateSchema),
  authority: z.object({
    toolAllowlist: z.array(z.string()).optional(),
    maxSteps: z.number().optional(),
    budgetLimitUsd: z.number().optional(),
    readOnly: z.boolean().optional(),
    scopePaths: z.array(z.string()).optional(),
  }),
  provenance: z.object({
    producerAgentId: z.string().optional(),
    producerModelId: z.string().optional(),
    runId: z.string().optional(),
    taskId: z.string().optional(),
    parentContractId: z.string().optional(),
    createdAt: z.number(),
  }),
  status: z.enum([
    "draft",
    "issued",
    "executing",
    "fulfilled",
    "failed",
    "rejected",
  ]),
}) as z.ZodType<AgentContract>;

// ── Construction ─────────────────────────────────────────────────────

/** Crockford-ish ulid-ish id: sortable timestamp prefix + random suffix. */
function ulidish(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString("hex");
  return `${ts}${rand}`;
}

export interface CreateContractInput {
  intent: string;
  context?: string;
  nonGoals?: string[];
  inputs: AgentContract["inputs"];
  output?: Partial<AgentContract["output"]>;
  acceptance?: AcceptanceGate[];
  authority?: AgentContract["authority"];
  provenance?: Partial<AgentContract["provenance"]>;
  status?: AgentContract["status"];
}

/**
 * Build a fully-formed, validated AgentContract from a partial. Assigns the id
 * (ct_<ulid-ish>), provenance.createdAt, and a default status. Validates via
 * AgentContractSchema so a malformed contract fails at authoring time, in the
 * producer's context, rather than downstream.
 */
export function createContract(input: CreateContractInput): AgentContract {
  const contract: AgentContract = {
    id: `ct_${ulidish()}`,
    version: 1,
    intent: input.intent,
    context: input.context ?? "",
    nonGoals: input.nonGoals,
    inputs: input.inputs,
    output: {
      contentType: input.output?.contentType ?? "text",
      schemaRef: input.output?.schemaRef,
      inlineSchemaJson: input.output?.inlineSchemaJson,
    },
    acceptance: input.acceptance ?? [],
    authority: input.authority ?? {},
    provenance: {
      producerAgentId: input.provenance?.producerAgentId,
      producerModelId: input.provenance?.producerModelId,
      runId: input.provenance?.runId,
      taskId: input.provenance?.taskId,
      parentContractId: input.provenance?.parentContractId,
      createdAt: input.provenance?.createdAt ?? Date.now(),
    },
    status: input.status ?? "draft",
  };

  const parsed = AgentContractSchema.safeParse(contract);
  if (!parsed.success) {
    throw new Error(
      `invalid contract: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

// ── Rendering ────────────────────────────────────────────────────────

export interface RenderOptions {
  /** When true, render for a JUDGE: excludes the producer's self-reported
   * confidence and producer identity so the panel cannot anchor on the
   * author's own assessment (quorum-gaming / anchoring mitigation). */
  forJudge?: boolean;
  /** The producer's self-reported confidence (0-1). Rendered only for the
   * consumer, never for a judge. Not a stored contract field — it lives on the
   * producer's structured output. */
  producerConfidence?: number;
  /** Transient corrective feedback from a prior gate attempt (revise loop).
   * When present, renders a deterministic "Prior attempt — corrective
   * feedback" section between Task and Deliverable. NEVER mutates the contract;
   * the acceptance criteria are unchanged. Absent → byte-identical to today. */
  priorAttempt?: PriorAttemptFeedback;
}

/**
 * Deterministically render a contract into a consumer/judge prompt. Sections:
 * Intent / Context / Non-goals / Task / Deliverable schema / Acceptance
 * criteria / Authority. Model-agnostic — any BR-routed model executes the same
 * render. For judges, producer self-reported confidence and producer identity
 * are excluded.
 */
export function renderContractPrompt(
  contract: AgentContract,
  opts: RenderOptions = {},
): string {
  const forJudge = opts.forJudge ?? false;
  const out: string[] = [];

  out.push("## Intent");
  out.push(contract.intent.trim());

  out.push("");
  out.push("## Context");
  out.push(contract.context.trim() || "(none provided)");

  out.push("");
  out.push("## Non-goals");
  if (contract.nonGoals && contract.nonGoals.length > 0) {
    for (const g of contract.nonGoals) out.push(`- ${g}`);
  } else {
    out.push("(none specified)");
  }

  out.push("");
  out.push("## Task");
  out.push(contract.inputs.task.trim());
  if (contract.inputs.artifacts && contract.inputs.artifacts.length > 0) {
    out.push("");
    out.push("Input artifacts:");
    for (const a of contract.inputs.artifacts) out.push(`- ${a}`);
  }

  // Prior-attempt corrective feedback (revise loop). Deterministic, and only
  // emitted when a prior gate attempt supplied it — so every existing caller
  // (including the panel's forJudge render) is byte-identical to today.
  if (opts.priorAttempt) {
    const fb = opts.priorAttempt;
    out.push("");
    out.push("## Prior attempt — corrective feedback");
    out.push(
      `A prior attempt (attempt ${fb.attempt}) did not pass the merge gate. ` +
        `Address the issues below before re-satisfying the acceptance criteria; ` +
        `the criteria themselves are unchanged.`,
    );
    if (fb.failedCriteria.length > 0) {
      out.push("");
      out.push("Unmet acceptance criteria:");
      for (const c of fb.failedCriteria) {
        out.push(`- ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ""}`);
      }
    }
    if (fb.findings.length > 0) {
      out.push("");
      out.push("Top findings:");
      for (const f of fb.findings) {
        out.push(
          `- [${f.severity}] ${f.description}${f.file ? ` (${f.file})` : ""}`,
        );
      }
    }
    if (fb.dissent.length > 0) {
      out.push("");
      out.push("Dissent:");
      for (const d of fb.dissent) out.push(`- ${d}`);
    }
    if (fb.summary.trim()) {
      out.push("");
      out.push(`Summary: ${fb.summary.trim()}`);
    }
  }

  out.push("");
  out.push("## Deliverable schema");
  out.push(`Content type: ${contract.output.contentType}`);
  if (contract.output.schemaRef) {
    out.push(`Output schema: ${contract.output.schemaRef}`);
    out.push(
      "Respond with a single JSON object matching this schema (fenced in a ```json block).",
    );
  } else if (contract.output.inlineSchemaJson) {
    out.push("Output must match the following inline JSON schema:");
    out.push("```json");
    out.push(contract.output.inlineSchemaJson);
    out.push("```");
  }

  out.push("");
  out.push("## Acceptance criteria");
  if (contract.acceptance.length === 0) {
    out.push("(none — best-effort)");
  } else {
    for (const gate of contract.acceptance) {
      out.push(`- ${describeGate(gate)}`);
    }
  }

  out.push("");
  out.push("## Authority");
  const auth = contract.authority;
  if (auth.readOnly) out.push("- Read-only: you may not mutate state.");
  if (auth.toolAllowlist && auth.toolAllowlist.length > 0) {
    out.push(`- Allowed tools: ${auth.toolAllowlist.join(", ")}`);
  }
  if (typeof auth.maxSteps === "number") {
    out.push(`- Max steps: ${auth.maxSteps}`);
  }
  if (typeof auth.budgetLimitUsd === "number") {
    out.push(`- Budget limit: $${auth.budgetLimitUsd}`);
  }
  if (auth.scopePaths && auth.scopePaths.length > 0) {
    out.push(`- Scope paths: ${auth.scopePaths.join(", ")}`);
  }
  if (
    !auth.readOnly &&
    !auth.toolAllowlist?.length &&
    auth.maxSteps === undefined &&
    auth.budgetLimitUsd === undefined &&
    !auth.scopePaths?.length
  ) {
    out.push("(no additional restrictions)");
  }

  // Provenance / producer confidence — consumer only, withheld from judges.
  if (!forJudge) {
    const provLines: string[] = [];
    if (contract.provenance.producerAgentId) {
      provLines.push(
        `- Producer agent: ${contract.provenance.producerAgentId}`,
      );
    }
    if (contract.provenance.producerModelId) {
      provLines.push(
        `- Producer model: ${contract.provenance.producerModelId}`,
      );
    }
    if (typeof opts.producerConfidence === "number") {
      provLines.push(
        `- Producer self-reported confidence: ${opts.producerConfidence}`,
      );
    }
    if (provLines.length > 0) {
      out.push("");
      out.push("## Provenance");
      out.push(...provLines);
    }
  }

  return out.join("\n");
}

function describeGate(gate: AcceptanceGate): string {
  switch (gate.kind) {
    case "schema":
      return "Output must parse against the declared output schema.";
    case "command":
      return `Command must succeed: \`${gate.cmd}\``;
    case "files_touched_within":
      return `Changes must stay within: ${gate.paths.join(", ")}`;
    case "panel":
      return `Judge panel must approve${
        gate.panelConfigRef ? ` (config: ${gate.panelConfigRef})` : ""
      }.`;
    case "criterion":
      return gate.text;
    default:
      return "(unknown gate)";
  }
}

// ── Output validation ────────────────────────────────────────────────

export interface ValidateOutputResult {
  ok: boolean;
  parsed?: unknown;
  errors: string[];
}

/**
 * Extract the first fenced ```json block from a model response, falling back to
 * the first balanced top-level JSON object/array. Returns undefined if none is
 * found.
 */
export function extractJsonBlock(rawText: string): string | undefined {
  const fence = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) {
    return fence[1].trim();
  }
  // Fall back to the first balanced {...} or [...] span.
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

/**
 * Validate a consumer's raw output against the contract's declared output
 * schema. Resolves output.schemaRef via the injected getOutputSchema (so
 * contracts never imports agents' OUTPUT_SCHEMAS directly — the resolver is
 * injected to avoid coupling), extracts the JSON block, and safeParses.
 *
 * Contracts with no schemaRef and a non-json contentType are trivially valid
 * (nothing to enforce). This finally enforces what WorkflowStepDef.outputSchema
 * declared but the engine never checked.
 */
export function validateContractOutput(
  contract: AgentContract,
  rawText: string,
  getOutputSchema: (name: string) => z.ZodType | undefined,
): ValidateOutputResult {
  const schemaRef = contract.output.schemaRef;
  if (!schemaRef) {
    // No structured schema declared — nothing to validate against.
    return { ok: true, errors: [] };
  }

  const schema = getOutputSchema(schemaRef);
  if (!schema) {
    return {
      ok: false,
      errors: [`unknown output schema: ${schemaRef}`],
    };
  }

  const block = extractJsonBlock(rawText);
  if (block === undefined) {
    return {
      ok: false,
      errors: ["no JSON block found in output"],
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }

  return { ok: true, parsed: parsed.data, errors: [] };
}
