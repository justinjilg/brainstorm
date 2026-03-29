import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { EvalRun, CapabilityDimension } from "./types.js";
import type { CapabilityScores } from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import { createGatewayClient } from "@brainst0rm/gateway";

const log = createLogger("eval:export");

const SCORES_DIR = join(homedir(), ".brainstorm", "eval");
const SCORES_FILE = join(SCORES_DIR, "capability-scores.json");

/**
 * Map eval dimension names to CapabilityScores field names.
 */
const DIMENSION_TO_FIELD: Record<CapabilityDimension, keyof CapabilityScores> =
  {
    "tool-selection": "toolSelection",
    "tool-sequencing": "toolSequencing",
    "code-correctness": "codeGeneration",
    "multi-step": "multiStepReasoning",
    "instruction-adherence": "instructionFollowing",
    "context-utilization": "contextUtilization",
    "self-correction": "selfCorrection",
  };

/**
 * Export an eval run's scores as CapabilityScores for the model registry.
 * Persists to ~/.brainstorm/eval/capability-scores.json.
 */
export function exportCapabilityScores(run: EvalRun): CapabilityScores {
  const scores: CapabilityScores = {
    toolSelection: 0,
    toolSequencing: 0,
    codeGeneration: 0,
    multiStepReasoning: 0,
    instructionFollowing: 0,
    contextUtilization: 0,
    selfCorrection: 0,
  };

  for (const [dim, score] of Object.entries(run.scores)) {
    const field = DIMENSION_TO_FIELD[dim as CapabilityDimension];
    if (field) scores[field] = score;
  }

  // Persist locally
  const allScores = loadAllCapabilityScores();
  allScores[run.modelId] = {
    scores,
    evaluatedAt: run.completedAt ?? Date.now(),
  };
  saveAllCapabilityScores(allScores);

  // Push to BrainstormRouter gateway (fire-and-forget)
  pushToGateway(run.modelId, scores).catch((err) => {
    log.warn(
      { modelId: run.modelId, err },
      "Failed to push capability scores to gateway",
    );
  });

  log.info({ modelId: run.modelId, scores }, "Exported capability scores");
  return scores;
}

/**
 * Load persisted capability scores for all models.
 */
export function loadAllCapabilityScores(): Record<
  string,
  { scores: CapabilityScores; evaluatedAt: number }
> {
  if (!existsSync(SCORES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SCORES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Get capability scores for a specific model.
 */
export function getCapabilityScores(modelId: string): CapabilityScores | null {
  const all = loadAllCapabilityScores();
  return all[modelId]?.scores ?? null;
}

function saveAllCapabilityScores(
  data: Record<string, { scores: CapabilityScores; evaluatedAt: number }>,
): void {
  if (!existsSync(SCORES_DIR)) mkdirSync(SCORES_DIR, { recursive: true });
  writeFileSync(SCORES_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** Push capability scores to BrainstormRouter gateway. */
async function pushToGateway(
  modelId: string,
  scores: CapabilityScores,
): Promise<void> {
  const gw = createGatewayClient();
  if (!gw) return;

  await gw.pushCapabilityScores(
    modelId,
    scores as unknown as Record<string, number>,
  );
  log.info({ modelId }, "Pushed capability scores to gateway");
}
