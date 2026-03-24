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
  timeout?: number;
}

/**
 * Run the eval CLI command.
 * Called from packages/cli/src/bin/brainstorm.ts.
 */
export async function runEvalCli(options: EvalCliOptions): Promise<void> {
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
