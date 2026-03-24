#!/usr/bin/env npx tsx
/**
 * Multi-model workflow demo.
 *
 * Runs the implement-feature preset workflow, showing how BrainstormRouter
 * picks different models per step: capable for architect/coder, cheap for reviewer.
 *
 * Usage: npx tsx tests/workflow-demo/run-demo.ts
 * Requires: BRAINSTORM_API_KEY env var
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAINSTORM_CLI = join(__dirname, '../../packages/cli/dist/brainstorm.js');
const OUTPUT_DIR = join(__dirname, 'output');

interface StepResult {
  step: string;
  model: string;
  cost: number;
  durationMs: number;
  output: string;
}

/**
 * Run the workflow demo using brainstorm CLI.
 *
 * Since the workflow CLI command needs more wiring for step-model overrides,
 * we simulate the workflow by running 3 sequential brainstorm run commands
 * with different model hints via the routing strategy.
 */
async function main() {
  console.log('Multi-Model Workflow Demo');
  console.log('========================\n');

  if (!process.env.BRAINSTORM_API_KEY) {
    console.log('Note: BRAINSTORM_API_KEY not set — will use local models.\n');
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const results: StepResult[] = [];
  const task = 'Add a utility function that converts CSV text to JSON objects, with header row detection and type coercion for numbers and booleans.';

  // Step 1: Architect — plan the implementation (quality-first routing)
  console.log('Step 1: ARCHITECT — design the implementation\n');
  const architectResult = await runStep(
    `You are an architect. Design the implementation for: ${task}\n\nReturn a structured plan with: file name, function signature, edge cases to handle, and test cases to write. Do NOT write code yet — just the spec.`,
    'quality-first',
  );
  results.push({ step: 'architect', ...architectResult });

  // Step 2: Coder — implement (quality-first routing for capable model)
  console.log('Step 2: CODER — implement the design\n');
  const coderResult = await runStep(
    `You are a coder. Implement the following design:\n\n${architectResult.output.slice(0, 2000)}\n\nCreate the file csv-to-json.ts with the implementation. Follow the spec precisely. Write clean TypeScript.`,
    'quality-first',
  );
  results.push({ step: 'coder', ...coderResult });

  // Step 3: Reviewer — review (cost-first routing for cheap model)
  console.log('Step 3: REVIEWER — review the implementation\n');
  const reviewerResult = await runStep(
    `You are a code reviewer. Review the implementation:\n\n${coderResult.output.slice(0, 2000)}\n\nCheck for: bugs, edge cases, TypeScript correctness, error handling. Return: APPROVED or REJECTED with specific feedback.`,
    'cost-first',
  );
  results.push({ step: 'reviewer', ...reviewerResult });

  // Report
  console.log('\n' + '='.repeat(60));
  console.log('WORKFLOW RESULTS');
  console.log('='.repeat(60) + '\n');

  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const totalTime = results.reduce((s, r) => s + r.durationMs, 0);
  const models = new Set(results.map((r) => r.model));

  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`Models used: ${Array.from(models).join(', ')}\n`);

  console.log('| Step | Model | Cost | Time |');
  console.log('|------|-------|------|------|');
  for (const r of results) {
    console.log(`| ${r.step} | ${r.model} | $${r.cost.toFixed(4)} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }

  // Save report
  const report = [
    '# Workflow Demo Report',
    '',
    `**Task:** ${task}`,
    `**Date:** ${new Date().toISOString().split('T')[0]}`,
    `**Total cost:** $${totalCost.toFixed(4)}`,
    `**Total time:** ${(totalTime / 1000).toFixed(1)}s`,
    `**Models:** ${Array.from(models).join(', ')}`,
    '',
    ...results.map((r) => [
      `## ${r.step.toUpperCase()}`,
      `Model: ${r.model} | Cost: $${r.cost.toFixed(4)} | Time: ${(r.durationMs / 1000).toFixed(1)}s`,
      '',
      r.output.slice(0, 1000),
      '',
    ]).flat(),
  ].join('\n');

  writeFileSync(join(__dirname, 'REPORT.md'), report);
  console.log('\nReport saved to tests/workflow-demo/REPORT.md');
}

async function runStep(prompt: string, strategy: string): Promise<Omit<StepResult, 'step'>> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('node', [
      BRAINSTORM_CLI, 'run', prompt,
      '--tools', '--max-steps', '10', '--json',
      '--strategy', strategy,
    ], {
      cwd: OUTPUT_DIR,
      timeout: 180_000,
      env: { ...process.env, BRAINSTORM_LOG_LEVEL: 'warn' },
    });

    const durationMs = Date.now() - start;
    let parsed: any;
    try { parsed = JSON.parse(stdout.trim()); } catch {}

    const model = parsed?.model ?? extractModel(stderr) ?? 'unknown';
    const cost = parsed?.cost ?? 0;
    const output = parsed?.text ?? stdout;

    console.log(`  Model: ${model} | Cost: $${cost.toFixed(4)} | Time: ${(durationMs / 1000).toFixed(1)}s\n`);

    return { model, cost, durationMs, output };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    console.log(`  FAILED: ${err.message?.slice(0, 100)}\n`);
    return { model: 'error', cost: 0, durationMs, output: err.message ?? '' };
  }
}

function extractModel(text: string): string | undefined {
  const match = text.match(/→\s*([a-zA-Z][a-zA-Z0-9._-]+)/);
  return match?.[1];
}

main().catch((err) => {
  console.error('Demo crashed:', err);
  process.exit(1);
});
