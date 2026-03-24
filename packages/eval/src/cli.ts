import { loadProbes, loadProbesByCapability } from './loader.js';
import { runAllProbes } from './runner.js';
import { saveEvalRun, buildScorecard, loadEvalRuns } from './storage.js';
import { formatScorecard, formatComparison } from './scorecard.js';
import { exportCapabilityScores } from './export.js';
import type { CapabilityDimension } from './types.js';

export interface EvalCliOptions {
  model?: string;
  capability?: string;
  compare?: boolean;
  scorecard?: boolean;
  allModels?: boolean;
  timeout?: number;
}

/**
 * Run the eval CLI command.
 * Called from packages/cli/src/bin/brainstorm.ts.
 */
export async function runEvalCli(options: EvalCliOptions): Promise<void> {
  // Scorecard mode: show current scores without re-running
  if (options.scorecard) {
    const { loadAllCapabilityScores } = await import('./export.js');
    const allScores = loadAllCapabilityScores();
    if (Object.keys(allScores).length === 0) {
      console.log('\n  No capability scores found. Run `brainstorm eval --model <id>` first.\n');
      return;
    }
    console.log('\n  Capability Scores\n');
    for (const [modelId, entry] of Object.entries(allScores)) {
      const date = new Date(entry.evaluatedAt).toISOString().split('T')[0];
      const dims = Object.entries(entry.scores)
        .map(([k, v]) => `${k}: ${((v as number) * 100).toFixed(0)}%`)
        .join(', ');
      console.log(`  ${modelId} (${date}): ${dims}`);
    }
    console.log();
    return;
  }

  // Compare mode: show existing results
  if (options.compare) {
    const runs = loadEvalRuns();
    if (runs.length === 0) {
      console.log('\n  No eval results found. Run `brainstorm eval` first.\n');
      return;
    }

    // Get latest run per model
    const latestByModel = new Map<string, typeof runs[0]>();
    for (const run of runs) {
      latestByModel.set(run.modelId, run);
    }

    const scorecards = [...latestByModel.values()].map(buildScorecard);
    console.log(formatComparison(scorecards));
    return;
  }

  // All-models mode: run probes against every available model
  if (options.allModels) {
    const probes = options.capability
      ? loadProbesByCapability(options.capability as CapabilityDimension)
      : loadProbes();
    if (probes.length === 0) {
      console.log('\n  No probes found.\n');
      return;
    }

    // Dynamic import to avoid circular deps — providers is not a direct dependency of eval
    const { loadConfig } = await import('@brainstorm/config');
    const { createProviderRegistry } = await import('@brainstorm/providers');
    const config = loadConfig();
    const registry = await createProviderRegistry(config);
    const models = registry.models.filter((m: any) => m.status === 'available');

    console.log(`\n  Running ${probes.length} probes against ${models.length} models...\n`);
    for (const model of models) {
      console.log(`  ── ${model.name} (${model.id}) ──`);
      const results = await runAllProbes(probes, {
        modelId: model.id,
        defaultTimeout: options.timeout ?? 30000,
      });
      const run = saveEvalRun(model.id, results);
      exportCapabilityScores(run);
      const passed = results.filter((r) => r.passed).length;
      console.log(`    ${passed}/${results.length} passed\n`);
    }

    // Show comparison at end
    const runs = loadEvalRuns();
    const latestByModel = new Map<string, typeof runs[0]>();
    for (const run of runs) latestByModel.set(run.modelId, run);
    const scorecards = [...latestByModel.values()].map(buildScorecard);
    console.log(formatComparison(scorecards));
    return;
  }

  // Load probes
  let probes = options.capability
    ? loadProbesByCapability(options.capability as CapabilityDimension)
    : loadProbes();

  if (probes.length === 0) {
    console.log('\n  No probes found. Check packages/eval/probes/ directory.\n');
    return;
  }

  const modelId = options.model ?? 'default';
  console.log(`\n  Running ${probes.length} probes${modelId !== 'default' ? ` on ${modelId}` : ''}...\n`);

  // Run probes
  const results = await runAllProbes(probes, {
    modelId,
    defaultTimeout: options.timeout ?? 30000,
  });

  // Save, export capability scores, and display
  const run = saveEvalRun(modelId, results);
  const exportedScores = exportCapabilityScores(run);
  console.log(`  Capability scores exported for ${modelId} (routing will use these next session)\n`);
  const scorecard = buildScorecard(run);
  console.log(formatScorecard(scorecard));

  // Show individual failures
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log(`  Failed probes (${failures.length}):\n`);
    for (const f of failures) {
      const failedChecks = f.checks.filter((c) => !c.passed);
      console.log(`    ${f.probeId}: ${failedChecks.map((c) => c.detail ?? c.check).join('; ')}`);
      if (f.error) console.log(`      Error: ${f.error}`);
    }
    console.log();
  }
}
