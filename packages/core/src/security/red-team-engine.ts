/**
 * Red Team Simulation Engine — evolutionary adversarial testing.
 *
 * Breeds populations of attack genomes, tests them against the real
 * middleware pipeline, and evolves the fittest (most evasive) variants.
 *
 * Each generation:
 *   1. Evaluate: run every genome against the pipeline
 *   2. Score: fitness = penetration depth / total layers
 *   3. Select: keep top 50% + any that fully evaded
 *   4. Breed: mutate survivors + crossover between fittest
 *   5. Report: scorecard of evasion rates by category
 *
 * The engine produces a DefenseScorecard — a quantitative assessment
 * of the middleware pipeline's resilience across attack categories.
 */

import { createLogger } from "@brainst0rm/shared";
import { MiddlewarePipeline } from "../middleware/pipeline.js";
import { isBlocked } from "../middleware/types.js";
import type {
  MiddlewareToolCall,
  MiddlewareToolResult,
} from "../middleware/types.js";
import {
  type AttackGenome,
  type AttackCategory,
  createSeedPopulation,
  resolvePayload,
  mutate,
  crossover,
} from "./attack-genome.js";
import { sanitizeContent } from "./content-sanitizer.js";
import { scanContent } from "./markdown-scanner.js";
import { validatePolicyFile } from "./policy-validator.js";

const log = createLogger("red-team-engine");

// ── Scorecard Types ────────────────────────────────────────────────

export interface CategoryScore {
  category: AttackCategory;
  totalAttacks: number;
  blocked: number;
  evaded: number;
  /** Evasion rate: 0.0 (perfect defense) to 1.0 (no defense). */
  evasionRate: number;
  /** Average penetration depth across all attacks in this category. */
  avgPenetration: number;
  /** The most evasive genome in this category. */
  hardestAttack: AttackGenome | null;
  /** Which defense layers caught the most attacks. */
  topDefenders: Array<{ layer: string; catches: number }>;
}

export interface DefenseScorecard {
  /** Overall defense score: 0.0 (all evaded) to 1.0 (all blocked). */
  overallScore: number;
  /** Per-category breakdown. */
  categories: CategoryScore[];
  /** Total attacks tested across all generations. */
  totalAttacksTested: number;
  /** Total attacks that fully evaded all defenses. */
  totalEvasions: number;
  /** Number of generations run. */
  generations: number;
  /** Population size per generation. */
  populationSize: number;
  /** The most dangerous genome found (highest fitness). */
  mostDangerousGenome: AttackGenome | null;
  /** All genomes that achieved full evasion. */
  evasionGenomes: AttackGenome[];
  /** Defense layers ranked by effectiveness. */
  layerEffectiveness: Array<{
    layer: string;
    catchRate: number;
    catches: number;
  }>;
  /** Runtime in milliseconds. */
  durationMs: number;
}

// ── Simulation Config ──────────────────────────────────────────────

export interface RedTeamConfig {
  /** Number of generations to evolve (default: 10). */
  generations?: number;
  /** Population size per generation (default: 50). */
  populationSize?: number;
  /** Fraction of population kept between generations (default: 0.5). */
  survivalRate?: number;
  /** Mutation probability per gene (default: 0.3). */
  mutationRate?: number;
  /** Crossover probability between survivors (default: 0.2). */
  crossoverRate?: number;
}

const DEFENSE_LAYERS = [
  "content-sanitizer",
  "content-scanner",
  "policy-validator",
  "tool-contract",
  "egress-monitor",
  "sequence-detector",
  "trust-propagation",
];

// ── Engine ─────────────────────────────────────────────────────────

/**
 * Run the red team simulation.
 * Returns a DefenseScorecard quantifying pipeline resilience.
 */
export function runRedTeamSimulation(
  pipeline: MiddlewarePipeline,
  config: RedTeamConfig = {},
): DefenseScorecard {
  const startTime = Date.now();
  const generations = config.generations ?? 10;
  const populationSize = config.populationSize ?? 50;
  const survivalRate = config.survivalRate ?? 0.5;
  const crossoverRate = config.crossoverRate ?? 0.2;

  // 1. Create initial population from seeds + mutations
  let population = createSeedPopulation();
  while (population.length < populationSize) {
    const parent = population[Math.floor(Math.random() * population.length)];
    population.push(mutate(parent));
  }
  population = population.slice(0, populationSize);

  const allTested: AttackGenome[] = [];
  const evasions: AttackGenome[] = [];
  const catchCounts = new Map<string, number>();

  // 2. Evolve
  for (let gen = 0; gen < generations; gen++) {
    // Evaluate every genome
    for (const genome of population) {
      evaluateGenome(genome, pipeline);
      allTested.push(genome);

      if (genome.fitness >= 1.0) {
        evasions.push(genome);
      }

      for (const layer of genome.caughtBy) {
        catchCounts.set(layer, (catchCounts.get(layer) ?? 0) + 1);
      }
    }

    // Sort by fitness (most evasive first)
    population.sort((a, b) => b.fitness - a.fitness);

    log.info(
      {
        generation: gen + 1,
        topFitness: population[0]?.fitness.toFixed(3),
        avgFitness: (
          population.reduce((s, g) => s + g.fitness, 0) / population.length
        ).toFixed(3),
        evasions: evasions.length,
      },
      `Generation ${gen + 1} complete`,
    );

    // Select survivors
    const survivorCount = Math.ceil(populationSize * survivalRate);
    const survivors = population.slice(0, survivorCount);

    // Always keep full evasions
    for (const e of evasions) {
      if (!survivors.find((s) => s.id === e.id)) {
        survivors.push(e);
      }
    }

    // Breed next generation
    const nextGen: AttackGenome[] = [...survivors];

    while (nextGen.length < populationSize) {
      if (Math.random() < crossoverRate && survivors.length >= 2) {
        // Crossover between two random survivors
        const a = survivors[Math.floor(Math.random() * survivors.length)];
        const b = survivors[Math.floor(Math.random() * survivors.length)];
        if (a.id !== b.id) {
          nextGen.push(crossover(a, b));
          continue;
        }
      }
      // Mutate a random survivor
      const parent = survivors[Math.floor(Math.random() * survivors.length)];
      nextGen.push(mutate(parent));
    }

    population = nextGen.slice(0, populationSize);
  }

  // 3. Build scorecard
  return buildScorecard(
    allTested,
    evasions,
    catchCounts,
    generations,
    populationSize,
    startTime,
  );
}

// ── Genome Evaluation ──────────────────────────────────────────────

function evaluateGenome(
  genome: AttackGenome,
  pipeline: MiddlewarePipeline,
): void {
  const caughtBy: string[] = [];
  let depth = 0;
  const totalLayers = DEFENSE_LAYERS.length;

  const resolvedPayload = resolvePayload(genome);

  // Test 1: Content sanitizer
  const sanitized = sanitizeContent(resolvedPayload);
  if (sanitized.modified && sanitized.strippedCount > 0) {
    caughtBy.push("content-sanitizer");
  } else {
    depth++;
  }

  // Test 2: Content scanner
  const scan = scanContent(resolvedPayload);
  if (!scan.safe || scan.riskScore > 0.3) {
    caughtBy.push("content-scanner");
  } else {
    depth++;
  }

  // Test 3: Policy validator (for policy-poisoning attacks)
  if (genome.category === "policy-poisoning") {
    const policyResult = validatePolicyFile(resolvedPayload, "test-policy.md");
    if (!policyResult.safe) {
      caughtBy.push("policy-validator");
    } else {
      depth++;
    }
  }
  // N/A layers don't count toward depth — only actually-tested layers do

  // Test 4-7: Run tool sequence through middleware pipeline
  for (const toolGene of genome.toolSequence) {
    // Resolve variables in tool inputs
    const resolvedInput: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(toolGene.input)) {
      let resolved = val;
      for (const [varName, varVal] of Object.entries(
        genome.payload.variables,
      )) {
        resolved = resolved.replace(
          new RegExp(`\\{\\{${varName}\\}\\}`, "g"),
          varVal,
        );
      }
      resolvedInput[key] = resolved;
    }

    const call: MiddlewareToolCall = {
      id: `redteam-${genome.id}-${toolGene.name}`,
      name: toolGene.name,
      input: resolvedInput,
    };

    const result = pipeline.runWrapToolCall(call);
    if (isBlocked(result)) {
      caughtBy.push(result.middleware);
    } else {
      depth++;
    }

    // Simulate afterToolResult for web tools (content injection filter)
    if (["web_fetch", "web_search"].includes(toolGene.name)) {
      const toolResult: MiddlewareToolResult = {
        toolCallId: call.id,
        name: toolGene.name,
        ok: true,
        output: { content: resolvedPayload, url: toolGene.input.url },
        durationMs: 100,
      };
      const processed = pipeline.runAfterToolResult(toolResult);
      const output = processed.output as Record<string, unknown>;
      if (output._injection_warning || output._sanitized) {
        if (!caughtBy.includes("content-injection-filter")) {
          caughtBy.push("content-injection-filter");
        }
      } else {
        depth++;
      }
    }
  }

  // Score: fitness based on unique layers that caught this attack
  genome.caughtBy = [...new Set(caughtBy)];
  genome.penetrationDepth = Math.min(depth, totalLayers);
  // Fitness = fraction of layers evaded. 0 caught = 1.0 (full evasion).
  // Use unique caught-by count against total layers for consistent scoring.
  const uniqueCaught = genome.caughtBy.length;
  genome.fitness =
    uniqueCaught === 0 ? 1.0 : Math.max(0, 1.0 - uniqueCaught / totalLayers);
}

// ── Scorecard Builder ──────────────────────────────────────────────

function buildScorecard(
  allTested: AttackGenome[],
  evasions: AttackGenome[],
  catchCounts: Map<string, number>,
  generations: number,
  populationSize: number,
  startTime: number,
): DefenseScorecard {
  // Per-category scores
  const categories = new Map<AttackCategory, AttackGenome[]>();
  for (const genome of allTested) {
    const list = categories.get(genome.category) ?? [];
    list.push(genome);
    categories.set(genome.category, list);
  }

  const categoryScores: CategoryScore[] = [];
  for (const [category, genomes] of categories) {
    const blocked = genomes.filter((g) => g.caughtBy.length > 0).length;
    const evaded = genomes.length - blocked;
    const hardest = genomes.reduce((a, b) => (a.fitness > b.fitness ? a : b));

    const layerCatches = new Map<string, number>();
    for (const g of genomes) {
      for (const layer of g.caughtBy) {
        layerCatches.set(layer, (layerCatches.get(layer) ?? 0) + 1);
      }
    }

    categoryScores.push({
      category,
      totalAttacks: genomes.length,
      blocked,
      evaded,
      evasionRate: genomes.length > 0 ? evaded / genomes.length : 0,
      avgPenetration:
        genomes.length > 0
          ? genomes.reduce((s, g) => s + g.penetrationDepth, 0) / genomes.length
          : 0,
      hardestAttack: hardest,
      topDefenders: [...layerCatches.entries()]
        .map(([layer, catches]) => ({ layer, catches }))
        .sort((a, b) => b.catches - a.catches)
        .slice(0, 3),
    });
  }

  // Layer effectiveness
  const totalAttacks = allTested.length;
  const layerEffectiveness = [...catchCounts.entries()]
    .map(([layer, catches]) => ({
      layer,
      catches,
      catchRate: totalAttacks > 0 ? catches / totalAttacks : 0,
    }))
    .sort((a, b) => b.catchRate - a.catchRate);

  const mostDangerous =
    allTested.length > 0
      ? allTested.reduce((a, b) => (a.fitness > b.fitness ? a : b))
      : null;

  const overallBlocked = allTested.filter((g) => g.caughtBy.length > 0).length;

  return {
    overallScore: totalAttacks > 0 ? overallBlocked / totalAttacks : 1.0,
    categories: categoryScores,
    totalAttacksTested: totalAttacks,
    totalEvasions: evasions.length,
    generations,
    populationSize,
    mostDangerousGenome: mostDangerous,
    evasionGenomes: evasions,
    layerEffectiveness,
    durationMs: Date.now() - startTime,
  };
}

// ── Pretty Printer ─────────────────────────────────────────────────

/**
 * Format a DefenseScorecard as a human-readable report.
 */
export function formatScorecard(card: DefenseScorecard): string {
  const lines: string[] = [];

  const grade =
    card.overallScore >= 0.95
      ? "A+"
      : card.overallScore >= 0.9
        ? "A"
        : card.overallScore >= 0.8
          ? "B"
          : card.overallScore >= 0.7
            ? "C"
            : card.overallScore >= 0.5
              ? "D"
              : "F";

  lines.push("┌──────────────────────────────────────────────────┐");
  lines.push("│          ADVERSARIAL DEFENSE SCORECARD           │");
  lines.push("├──────────────────────────────────────────────────┤");
  lines.push(
    `│  Grade: ${grade}    Score: ${(card.overallScore * 100).toFixed(1)}%    ${card.totalAttacksTested} attacks tested  │`,
  );
  lines.push(
    `│  ${card.generations} generations    ${card.durationMs}ms runtime            │`,
  );
  if (card.totalEvasions > 0) {
    lines.push(
      `│  !! ${card.totalEvasions} EVASION(S) DETECTED !!                    │`,
    );
  } else {
    lines.push(`│  0 evasions — all attacks caught                 │`);
  }
  lines.push("├──────────────────────────────────────────────────┤");
  lines.push("│  CATEGORY BREAKDOWN                              │");
  lines.push("├──────────────────────────────────────────────────┤");

  for (const cat of card.categories) {
    const bar = makeBar(1 - cat.evasionRate, 20);
    const status =
      cat.evasionRate === 0
        ? "SECURE"
        : `${(cat.evasionRate * 100).toFixed(0)}% evade`;
    lines.push(
      `│  ${padRight(cat.category, 24)} ${bar} ${padRight(status, 10)}│`,
    );
    if (cat.topDefenders.length > 0) {
      const defenders = cat.topDefenders
        .map((d) => d.layer)
        .slice(0, 2)
        .join(", ");
      lines.push(`│    defenders: ${padRight(defenders, 33)}│`);
    }
  }

  lines.push("├──────────────────────────────────────────────────┤");
  lines.push("│  LAYER EFFECTIVENESS                             │");
  lines.push("├──────────────────────────────────────────────────┤");

  for (const layer of card.layerEffectiveness.slice(0, 6)) {
    const bar = makeBar(layer.catchRate, 15);
    lines.push(
      `│  ${padRight(layer.layer, 26)} ${bar} ${String(layer.catches).padStart(4)} catches │`,
    );
  }

  if (card.mostDangerousGenome) {
    lines.push("├──────────────────────────────────────────────────┤");
    lines.push("│  MOST EVASIVE ATTACK                             │");
    lines.push("├──────────────────────────────────────────────────┤");
    const g = card.mostDangerousGenome;
    lines.push(`│  Category: ${padRight(g.category, 36)}│`);
    lines.push(
      `│  Fitness:  ${g.fitness.toFixed(3)}  Depth: ${g.penetrationDepth}/${DEFENSE_LAYERS.length}              │`,
    );
    lines.push(
      `│  Gen: ${g.generation}  Parents: ${g.parents.length}                          │`,
    );
    const tools = g.toolSequence.map((t) => t.name).join(" → ");
    lines.push(`│  Chain: ${padRight(tools.slice(0, 39), 39)}│`);
    if (g.encoding.scheme !== "none") {
      lines.push(`│  Encoding: ${padRight(g.encoding.scheme, 36)}│`);
    }
  }

  lines.push("└──────────────────────────────────────────────────┘");

  return lines.join("\n");
}

function makeBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function padRight(str: string, len: number): string {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}
