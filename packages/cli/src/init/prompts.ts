import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { ProjectDetection } from './detect.js';
import type { InitChoices } from './templates.js';

/**
 * Interactive prompt flow for brainstorm init.
 * Uses readline/promises (same as chat --simple, no new deps).
 */
export async function runPrompts(detection: ProjectDetection): Promise<InitChoices | null> {
  const rl = createInterface({ input, output });

  try {
    console.log('\n  brainstorm init\n');

    // Show detection results
    const detected: string[] = [];
    if (detection.type) detected.push(`${detection.language ?? 'unknown'} ${detection.type}`);
    if (detection.framework && detection.framework !== 'none') detected.push(`framework: ${detection.framework}`);
    if (detection.localModels.length > 0) detected.push(`local models: ${detection.localModels.join(', ')}`);

    if (detected.length > 0) {
      console.log(`  Detected: ${detected.join(' | ')}\n`);
    }

    const name = await ask(rl, 'Project name', detection.name);
    const type = await askChoice(rl, 'Project type', ['monorepo', 'app', 'cli', 'library', 'api'], detection.type ?? 'app');
    const language = await askChoice(rl, 'Language', ['typescript', 'python', 'rust', 'go', 'multi'], detection.language ?? 'typescript');
    const framework = await askChoice(rl, 'Framework', ['nextjs', 'hono', 'fastapi', 'express', 'none'], detection.framework ?? 'none');
    const runtime = language === 'python' ? 'python' : language === 'go' ? 'go' : (detection.runtime ?? 'node') as InitChoices['runtime'];
    const deploy = await askChoice(rl, 'Deploy target', ['vercel', 'do-app-platform', 'docker', 'aws', 'none'], 'none');

    console.log();
    const cloudProvider = await askChoice(rl, 'Cloud LLM routing', ['brainstormrouter', 'direct', 'none'], 'brainstormrouter');
    const budgetTier = await askChoice(rl, 'Budget tier', ['low', 'standard', 'premium'], 'standard');

    console.log();
    const secretsStrategy = await askChoice(rl, 'Secrets strategy', ['env-file', 'op-cli', 'sops', 'doppler', 'infisical', 'manual'], 'env-file');
    const ciTier = await askChoice(rl, 'CI/CD setup', ['standard', 'full', 'monorepo', 'none'], type === 'monorepo' ? 'monorepo' : 'standard');

    console.log();
    const architecture = await ask(rl, 'Architecture (one line)', '');

    const choices: InitChoices = {
      name,
      type: type as InitChoices['type'],
      language: language as InitChoices['language'],
      framework: framework as InitChoices['framework'],
      runtime,
      deploy: deploy as InitChoices['deploy'],
      cloudProvider: cloudProvider as InitChoices['cloudProvider'],
      localModels: detection.localModels,
      budgetTier: budgetTier as InitChoices['budgetTier'],
      secretsStrategy: secretsStrategy as InitChoices['secretsStrategy'],
      ciTier: ciTier as InitChoices['ciTier'],
      architecture,
    };

    console.log('\n  Will create:');
    console.log('    STORM.md              — project context for AI routing');
    console.log('    brainstorm.toml       — routing + provider config');
    console.log('    .brainstormignore     — AI file exclusions');
    if (!detection.hasGitignore) console.log('    .gitignore            — comprehensive ignore patterns');
    if (!detection.hasPrettierrc) console.log('    .prettierrc           — code formatting');
    console.log('    .env.example          — documented environment variables');
    if (ciTier !== 'none') {
      console.log('    .github/workflows/    — CI/CD pipeline');
      console.log('    .github/ISSUE_TEMPLATE/ — bug + feature templates');
      console.log('    .github/pull_request_template.md');
    }

    console.log();
    const confirm = await ask(rl, 'Proceed? [Y/n]', 'Y');
    if (confirm.toLowerCase() === 'n') {
      console.log('  Aborted.\n');
      return null;
    }

    return choices;
  } finally {
    rl.close();
  }
}

/**
 * Build choices from detection defaults (for --yes mode).
 */
export function buildDefaultChoices(detection: ProjectDetection): InitChoices {
  return {
    name: detection.name,
    type: detection.type ?? 'app',
    language: (detection.language ?? 'typescript') as InitChoices['language'],
    framework: (detection.framework ?? 'none') as InitChoices['framework'],
    runtime: (detection.runtime ?? 'node') as InitChoices['runtime'],
    deploy: 'none',
    cloudProvider: 'brainstormrouter',
    localModels: detection.localModels,
    budgetTier: 'standard',
    secretsStrategy: 'env-file',
    ciTier: detection.type === 'monorepo' ? 'monorepo' : 'standard',
    architecture: '',
  };
}

async function ask(rl: any, prompt: string, defaultVal: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  const answer = await rl.question(`  ${prompt}${suffix}: `);
  return answer.trim() || defaultVal;
}

async function askChoice(rl: any, prompt: string, options: string[], defaultVal: string): Promise<string> {
  const optStr = options.map((o) => o === defaultVal ? `[${o}]` : o).join(' / ');
  const answer = await rl.question(`  ${prompt}: ${optStr}: `);
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return defaultVal;
  const match = options.find((o) => o.startsWith(trimmed));
  return match ?? defaultVal;
}
