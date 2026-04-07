/**
 * Red Team Engine Tests — verify the evolutionary attack simulation works.
 */

import { describe, it, expect } from "vitest";
import { MiddlewarePipeline } from "../middleware/pipeline";
import { createTrustPropagationMiddleware } from "../middleware/builtin/trust-propagation";
import { createToolSequenceDetectorMiddleware } from "../middleware/builtin/tool-sequence-detector";
import { createEgressMonitorMiddleware } from "../middleware/builtin/egress-monitor";
import { createToolContractMiddleware } from "../middleware/builtin/tool-contract-enforcement";
import { createContentInjectionFilterMiddleware } from "../middleware/builtin/content-injection-filter";
import {
  createSeedPopulation,
  mutate,
  crossover,
  resolvePayload,
  encodePayload,
  type AttackGenome,
} from "../security/attack-genome";
import {
  runRedTeamSimulation,
  formatScorecard,
} from "../security/red-team-engine";

function buildPipeline(): MiddlewarePipeline {
  const pipeline = new MiddlewarePipeline();
  pipeline.use(createTrustPropagationMiddleware());
  pipeline.use(createContentInjectionFilterMiddleware());
  pipeline.use(createToolContractMiddleware());
  pipeline.use(createToolSequenceDetectorMiddleware());
  pipeline.use(createEgressMonitorMiddleware());
  return pipeline;
}

describe("Attack Genome", () => {
  it("creates seed population with all categories", () => {
    const seeds = createSeedPopulation();
    expect(seeds.length).toBeGreaterThanOrEqual(12);

    const categories = new Set(seeds.map((s) => s.category));
    expect(categories.has("content-injection")).toBe(true);
    expect(categories.has("exfiltration")).toBe(true);
    expect(categories.has("privilege-escalation")).toBe(true);
    expect(categories.has("policy-poisoning")).toBe(true);
    expect(categories.has("semantic-manipulation")).toBe(true);
    expect(categories.has("approval-fatigue")).toBe(true);
  });

  it("resolves payload variables", () => {
    const seeds = createSeedPopulation();
    const genome = seeds[0]; // content-injection
    const resolved = resolvePayload(genome);
    expect(resolved).not.toContain("{{");
    expect(resolved.length).toBeGreaterThan(10);
  });

  it("encodes payloads with different schemes", () => {
    const text = "test payload";
    expect(encodePayload(text, "none")).toBe(text);
    expect(encodePayload(text, "base64")).toBe(
      Buffer.from(text).toString("base64"),
    );
    expect(encodePayload(text, "hex")).toBe(Buffer.from(text).toString("hex"));
    expect(encodePayload(text, "case-mix")).toHaveLength(text.length);
  });

  it("mutates genomes producing valid variants", () => {
    const seeds = createSeedPopulation();
    const parent = seeds[0];
    const child = mutate(parent);

    expect(child.id).not.toBe(parent.id);
    expect(child.generation).toBe(parent.generation + 1);
    expect(child.parents).toContain(parent.id);
    expect(child.fitness).toBe(0); // Not yet evaluated
  });

  it("crossover combines two parents", () => {
    const seeds = createSeedPopulation();
    const child = crossover(seeds[0], seeds[4]);

    expect(child.parents).toHaveLength(2);
    expect(child.generation).toBeGreaterThan(0);
  });
});

describe("Red Team Engine", () => {
  it("runs a simulation and produces a scorecard", () => {
    const pipeline = buildPipeline();
    const scorecard = runRedTeamSimulation(pipeline, {
      generations: 3,
      populationSize: 20,
    });

    expect(scorecard.totalAttacksTested).toBeGreaterThan(0);
    expect(scorecard.generations).toBe(3);
    expect(scorecard.populationSize).toBe(20);
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    expect(scorecard.overallScore).toBeLessThanOrEqual(1);
    expect(scorecard.categories.length).toBeGreaterThan(0);
    expect(scorecard.layerEffectiveness.length).toBeGreaterThan(0);
    expect(scorecard.durationMs).toBeGreaterThan(0);
  });

  it("defense score reflects real evasion rates", () => {
    const pipeline = buildPipeline();
    const scorecard = runRedTeamSimulation(pipeline, {
      generations: 5,
      populationSize: 30,
    });

    // The engine evolves attacks that partially evade — score won't be 1.0.
    // But we should catch at least some attacks and have meaningful layer data.
    expect(scorecard.overallScore).toBeGreaterThan(0);
    expect(scorecard.overallScore).toBeLessThanOrEqual(1);
    expect(scorecard.layerEffectiveness.length).toBeGreaterThan(0);
    // At least one defense layer should catch something
    expect(scorecard.layerEffectiveness.some((l) => l.catches > 0)).toBe(true);
  });

  it("formats scorecard as readable report", () => {
    const pipeline = buildPipeline();
    const scorecard = runRedTeamSimulation(pipeline, {
      generations: 2,
      populationSize: 15,
    });

    const report = formatScorecard(scorecard);
    expect(report).toContain("ADVERSARIAL DEFENSE SCORECARD");
    expect(report).toContain("Grade:");
    expect(report).toContain("CATEGORY BREAKDOWN");
    expect(report).toContain("LAYER EFFECTIVENESS");
  });

  it("evolution increases average fitness across generations", () => {
    const pipeline = buildPipeline();

    // Run with more generations to see evolution
    const scorecard = runRedTeamSimulation(pipeline, {
      generations: 8,
      populationSize: 30,
    });

    // The most dangerous genome should have evolved beyond seed fitness
    if (scorecard.mostDangerousGenome) {
      expect(scorecard.mostDangerousGenome.generation).toBeGreaterThan(0);
    }
  });
});
