#!/usr/bin/env npx tsx
/**
 * Dogfood test — use Brainstorm to build a real website.
 *
 * Validates the full stack: CLI → BrainstormRouter → provider → tools → filesystem.
 * Uses `brainstorm run` with --tools for agentic execution.
 *
 * Usage: npx tsx tests/dogfood/run-dogfood.ts
 * Requires: BRAINSTORM_API_KEY env var (routes through BrainstormRouter)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReport } from './report.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAINSTORM_CLI = join(__dirname, '../../packages/cli/dist/brainstorm.js');
const PROJECT_DIR = join(__dirname, 'output');

interface DogfoodStep {
  name: string;
  prompt: string;
  maxSteps: number;
  expectedFiles?: string[];
}

interface StepResult {
  name: string;
  model: string;
  cost: number;
  durationMs: number;
  toolCalls: number;
  success: boolean;
  error?: string;
  output: string;
}

const STEPS: DogfoodStep[] = [
  {
    name: 'Project setup',
    prompt: 'Create the project structure for a modern single-page landing page website. Create these files: index.html (empty HTML5 boilerplate), styles.css (empty with a comment), script.js (empty with a comment), and an assets/ directory with a .gitkeep file.',
    maxSteps: 10,
    expectedFiles: ['index.html', 'styles.css', 'script.js'],
  },
  {
    name: 'SVG illustrations',
    prompt: 'Create 3 SVG files in the assets/ directory:\n1. assets/hero-illustration.svg — An abstract tech/network pattern with nodes and connecting lines, using blue/purple gradients. At least 400x300 viewBox.\n2. assets/icon-speed.svg — A stylized speedometer/gauge icon, 64x64 viewBox, using orange/yellow gradients.\n3. assets/icon-security.svg — A shield with a checkmark icon, 64x64 viewBox, using green gradients.\nEach SVG must be self-contained with no external dependencies.',
    maxSteps: 10,
    expectedFiles: ['assets/hero-illustration.svg', 'assets/icon-speed.svg', 'assets/icon-security.svg'],
  },
  {
    name: 'HTML + CSS',
    prompt: 'Build index.html with a complete responsive landing page:\n- Navigation bar with logo text "Brainstorm" and links (Features, Pricing, About)\n- Hero section: headline "AI-Powered Development", subtitle, CTA button, and embed assets/hero-illustration.svg as an <img>\n- Features grid (3 columns): each with an SVG icon from assets/, title, and description\n- Pricing section: placeholder div with id="pricing-app"\n- Footer with copyright\n\nIn styles.css, implement:\n- CSS custom properties for dark/light themes (--bg, --text, --accent, --card-bg)\n- Body defaults to dark theme (class="dark")\n- Responsive grid (flexbox/grid, mobile-first)\n- @keyframes fadeInUp animation\n- .reveal class for scroll-triggered fade-in\n- Smooth scrolling\n- Navigation sticky with backdrop-filter blur',
    maxSteps: 15,
    expectedFiles: ['index.html', 'styles.css'],
  },
  {
    name: 'Business logic',
    prompt: 'In script.js, implement these features:\n\n1. PRICING CALCULATOR: Create a PricingCalculator class with:\n   - 3 tiers: Starter ($9/user/mo), Pro ($29/user/mo), Enterprise ($79/user/mo)\n   - Volume discounts: 10% off for 10+ users, 20% off for 50+, 30% off for 100+\n   - Tax rates by region: US 8.5%, EU 20%, UK 20%, CA 13%, AU 10%, other 0%\n   - Method: calculate(tier, users, region) returns {subtotal, discount, tax, total}\n   - Render the pricing UI into #pricing-app with tier cards, user count slider (1-200), region dropdown\n\n2. THEME TOGGLE: Add a button in the nav that toggles dark/light class on <html>, persists to localStorage\n\n3. SCROLL REVEAL: Use IntersectionObserver to add .visible class to elements with .reveal when they enter viewport\n\nAll code should be vanilla JS (no frameworks). Initialize on DOMContentLoaded.',
    maxSteps: 15,
    expectedFiles: ['script.js'],
  },
  {
    name: 'Video player',
    prompt: 'Create video-player.js with a custom HTML5 video player component:\n\n1. VideoPlayer class that accepts a container element and optional video src URL\n2. Creates: video element, play/pause button, seek bar (range input), current time / duration display, volume slider, mute button, fullscreen toggle, playback speed selector (0.5x, 1x, 1.5x, 2x)\n3. Styled controls bar below the video (dark background, white icons using Unicode symbols)\n4. Add keyboard shortcuts: Space=play/pause, M=mute, F=fullscreen, Left/Right=seek 5s\n5. Export as default\n\nThen update index.html: add a "Demo" section before the footer with a VideoPlayer instance using a placeholder src. Import video-player.js as a module.\n\nAdd video player styles to styles.css.',
    maxSteps: 15,
    expectedFiles: ['video-player.js'],
  },
];

async function runStep(step: DogfoodStep, index: number): Promise<StepResult> {
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`Step ${index + 1}/${STEPS.length}: ${step.name}`);
  console.log(`[${'='.repeat(60)}]\n`);

  const start = Date.now();

  try {
    const { stdout } = await execFileAsync('node', [
      BRAINSTORM_CLI, 'run', step.prompt,
      '--tools',
      '--max-steps', String(step.maxSteps),
      '--json',
    ], {
      cwd: PROJECT_DIR,
      timeout: 300_000, // 5 min per step
      env: { ...process.env, BRAINSTORM_LOG_LEVEL: 'warn' },
    });

    const durationMs = Date.now() - start;

    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // If JSON parsing fails, treat the raw output as text
      parsed = { text: stdout, model: 'unknown', cost: 0, success: true };
    }

    const result: StepResult = {
      name: step.name,
      model: parsed.model ?? 'unknown',
      cost: parsed.cost ?? 0,
      durationMs,
      toolCalls: parsed.toolCalls ?? 0,
      success: parsed.success !== false,
      output: (parsed.text ?? stdout).slice(0, 500),
    };

    // Check expected files
    if (step.expectedFiles) {
      const missing = step.expectedFiles.filter((f) => !existsSync(join(PROJECT_DIR, f)));
      if (missing.length > 0) {
        result.success = false;
        result.error = `Missing expected files: ${missing.join(', ')}`;
      }
    }

    console.log(`  Model: ${result.model}`);
    console.log(`  Cost: $${result.cost.toFixed(4)}`);
    console.log(`  Time: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Status: ${result.success ? 'PASS' : 'FAIL'}`);
    if (result.error) console.log(`  Error: ${result.error}`);

    return result;
  } catch (err: any) {
    const durationMs = Date.now() - start;
    console.log(`  FAILED: ${err.message?.slice(0, 200)}`);
    return {
      name: step.name,
      model: 'unknown',
      cost: 0,
      durationMs,
      toolCalls: 0,
      success: false,
      error: err.message?.slice(0, 500),
      output: err.stderr?.slice(0, 500) ?? '',
    };
  }
}

async function runRepairStep(failedStep: StepResult): Promise<StepResult> {
  console.log(`\n  [REPAIR] Attempting to fix: ${failedStep.name}`);
  const repairPrompt = `The previous step "${failedStep.name}" failed with error: ${failedStep.error ?? 'unknown error'}. Please fix the issue. The output directory already has some files — read them first and fix what's broken.`;

  return runStep({
    name: `Repair: ${failedStep.name}`,
    prompt: repairPrompt,
    maxSteps: 10,
  }, -1);
}

function collectFileStats(dir: string, prefix = ''): Array<{ path: string; lines: number; bytes: number }> {
  const stats: Array<{ path: string; lines: number; bytes: number }> = [];
  if (!existsSync(dir)) return stats;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      stats.push(...collectFileStats(fullPath, relPath));
    } else {
      const content = readFileSync(fullPath, 'utf-8');
      stats.push({ path: relPath, lines: content.split('\n').length, bytes: stat.size });
    }
  }
  return stats;
}

async function main() {
  console.log('Brainstorm Dogfood Test');
  console.log('======================\n');

  if (!process.env.BRAINSTORM_API_KEY) {
    console.log('Note: BRAINSTORM_API_KEY not set — will use local models or default routing.\n');
  }

  // Create output directory
  mkdirSync(PROJECT_DIR, { recursive: true });

  const results: StepResult[] = [];
  const bugs: Array<{ step: string; error: string }> = [];

  for (let i = 0; i < STEPS.length; i++) {
    const result = await runStep(STEPS[i], i);
    results.push(result);

    if (!result.success) {
      bugs.push({ step: result.name, error: result.error ?? 'unknown' });
      // Attempt repair
      const repairResult = await runRepairStep(result);
      results.push(repairResult);
      if (!repairResult.success) {
        bugs.push({ step: repairResult.name, error: repairResult.error ?? 'repair failed' });
      }
    }
  }

  // Collect file stats
  const fileStats = collectFileStats(PROJECT_DIR);

  // Generate report
  const report = generateReport(results, bugs, fileStats);
  console.log('\n' + report);

  // Write report to file
  writeFileSync(join(__dirname, 'REPORT.md'), report);
  console.log(`\nReport saved to tests/dogfood/REPORT.md`);

  // Exit with appropriate code
  const coreSteps = results.filter((r) => !r.name.startsWith('Repair:'));
  const allPassed = coreSteps.every((r) => r.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Dogfood test crashed:', err);
  process.exit(2);
});
