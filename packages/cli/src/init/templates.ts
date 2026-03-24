export interface InitChoices {
  name: string;
  type: 'monorepo' | 'app' | 'cli' | 'library' | 'api';
  language: 'typescript' | 'python' | 'rust' | 'go' | 'java' | 'multi';
  framework: 'nextjs' | 'hono' | 'fastapi' | 'express' | 'none';
  runtime: 'node' | 'deno' | 'bun' | 'python' | 'go';
  deploy: 'vercel' | 'do-app-platform' | 'docker' | 'aws' | 'none';
  cloudProvider: 'brainstormrouter' | 'direct' | 'none';
  localModels: Array<'ollama' | 'lmstudio' | 'llamacpp'>;
  budgetTier: 'low' | 'standard' | 'premium';
  secretsStrategy: 'env-file' | 'op-cli' | 'sops' | 'doppler' | 'infisical' | 'manual';
  ciTier: 'standard' | 'full' | 'monorepo' | 'none';
  architecture: string;
}

// ── STORM.md ────────────────────────────────────────────────────────

export interface GatewayInfo {
  connected: boolean;
  modelCount: number;
  budget?: string;
  health: string;
}

export function generateStormMd(choices: InitChoices): string {
  const lines = [
    '---',
    'version: 1',
    `name: ${choices.name}`,
    `type: ${choices.type}`,
    `language: ${choices.language}`,
    `framework: ${choices.framework}`,
    `runtime: ${choices.runtime}`,
    `deploy: ${choices.deploy}`,
    'routing:',
    '  primary_tasks: [code-generation, debugging]',
    `  typical_complexity: moderate`,
    `  prefer_local: ${choices.budgetTier === 'low'}`,
    `  budget_tier: ${choices.budgetTier}`,
    'providers:',
    `  cloud: ${choices.cloudProvider}`,
    `  local: [${choices.localModels.join(', ')}]`,
    'secrets:',
    `  strategy: ${choices.secretsStrategy}`,
    `entry_points: []`,
    choices.language === 'typescript' ? 'test_command: npm test' : choices.language === 'python' ? 'test_command: pytest' : undefined,
    choices.language === 'typescript' ? 'build_command: npm run build' : undefined,
    choices.language === 'typescript' ? 'dev_command: npm run dev' : choices.language === 'python' ? 'dev_command: python -m uvicorn app:app --reload' : undefined,
    '---',
    '',
    '## What is this?',
    `<!-- One sentence. What does this project do? -->`,
    choices.architecture || '[Describe your project here.]',
    '',
    '## Start here',
    '<!-- The 5 files to read first to understand the architecture. -->',
    '- [Add your key entry point]',
    '- [Add your main abstraction]',
    '- [Add your data schema]',
    '- [Add your route definitions]',
    '- [Add your config file]',
    '',
    '## Commands that work',
    '<!-- Copy-pasteable. Must work on a fresh clone. -->',
    '```bash',
    choices.language === 'typescript' ? 'npm install' : choices.language === 'python' ? 'pip install -r requirements.txt' : '# install dependencies',
    choices.language === 'typescript' ? 'npm run dev' : choices.language === 'python' ? 'python -m uvicorn app:app --reload' : '# start dev server',
    choices.language === 'typescript' ? 'npm test' : choices.language === 'python' ? 'pytest' : '# run tests',
    choices.language === 'typescript' ? 'npm run build' : '# build',
    '```',
    '',
    '## Conventions',
    '<!-- Show patterns by example. I learn by reading code, not rules. -->',
    '```' + (choices.language === 'typescript' ? 'typescript' : choices.language),
    '// Add code examples of your project\'s patterns here',
    '```',
    '',
    '## Environment',
    '<!-- Required vars marked [REQUIRED]. -->',
    choices.cloudProvider === 'brainstormrouter' ? '- `BRAINSTORM_API_KEY` [REQUIRED] — BrainstormRouter SaaS key' : '- [Add required environment variables]',
    '',
    '## Don\'t touch',
    '<!-- Files I should never modify without asking. -->',
    '- [Add protected files/directories here]',
    '',
  ];

  return lines.filter((l) => l !== undefined).join('\n');
}

// ── brainstorm.toml ─────────────────────────────────────────────────

export function generateBrainstormToml(choices: InitChoices): string {
  const strategy = choices.budgetTier === 'low' ? 'cost-first'
    : choices.budgetTier === 'premium' ? 'quality-first'
    : 'combined';

  const lines = [
    '[general]',
    `defaultStrategy = "${strategy}"`,
    '',
    '[providers.gateway]',
    `enabled = ${choices.cloudProvider === 'brainstormrouter'}`,
    '',
    '[providers.ollama]',
    `enabled = ${choices.localModels.includes('ollama')}`,
    '',
    '[providers.lmstudio]',
    `enabled = ${choices.localModels.includes('lmstudio')}`,
    '',
    '[budget]',
    choices.budgetTier === 'low' ? 'daily = 2.00' : choices.budgetTier === 'premium' ? 'daily = 20.00' : 'daily = 5.00',
    'hardLimit = false',
    '',
  ];

  return lines.join('\n');
}

// ── .gitignore ──────────────────────────────────────────────────────

export function generateGitignore(choices: InitChoices): string {
  return `# Dependencies
node_modules/
.pnp.*
venv/
__pycache__/

# Build
dist/
build/
.next/
.turbo/
*.tsbuildinfo

# Environment & secrets
.env
.env.*
!.env.example
*.pem
*.key
secrets.dec.yaml

# Data
*.db
*.db-wal
*.db-shm

# IDE & OS
.idea/
.vscode/settings.json
*.swp
.DS_Store

# Test
coverage/

# Brainstorm
.brainstorm/cache/
`;
}

// ── .brainstormignore ───────────────────────────────────────────────

export function generateBrainstormignore(): string {
  return `# Build artifacts — never useful, always stale
dist/
build/
.next/
.turbo/
__pycache__/
*.pyc

# Dependencies — I don't need to read library source
node_modules/
.pnp.*
venv/

# Lock files — huge, never informative
package-lock.json
yarn.lock
pnpm-lock.yaml
Cargo.lock

# Binary/media — I can't read these meaningfully
*.jpg
*.png
*.gif
*.svg
*.ico
*.woff
*.woff2
*.ttf
*.eot
*.mp4
*.mp3
*.pdf

# Generated/cached
*.tsbuildinfo
coverage/
.cache/
.eslintcache

# Secrets — I should never see these
.env
.env.*
!.env.example
*.pem
*.key
*.p12
credentials.json
`;
}

// ── .prettierrc ─────────────────────────────────────────────────────

export function generatePrettierrc(): string {
  return JSON.stringify({
    semi: true,
    singleQuote: true,
    tabWidth: 2,
    printWidth: 100,
    trailingComma: 'all',
  }, null, 2) + '\n';
}

// ── .env.example ────────────────────────────────────────────────────

export function generateEnvExample(choices: InitChoices): string {
  const lines = [
    '# === LLM Providers ===',
  ];

  if (choices.cloudProvider === 'brainstormrouter') {
    lines.push(
      '# BrainstormRouter SaaS (recommended — routes to optimal model)',
      '# Sign up: https://brainstormrouter.com',
      'BRAINSTORM_API_KEY=',
    );
  } else if (choices.cloudProvider === 'direct') {
    lines.push(
      '# Direct provider keys (set the ones you use)',
      '# ANTHROPIC_API_KEY=',
      '# OPENAI_API_KEY=',
      '# GOOGLE_GENERATIVE_AI_API_KEY=',
      '# DEEPSEEK_API_KEY=',
    );
  }

  lines.push(
    '',
    '# === Local Models ===',
    '# Ollama runs on localhost:11434 by default (auto-detected)',
    '# LM Studio runs on localhost:1234 by default (auto-detected)',
    '',
    '# === Application ===',
    '# DATABASE_URL=',
    '# Add project-specific env vars below',
    '',
  );

  return lines.join('\n');
}

// ── CI/CD Workflows ─────────────────────────────────────────────────

export function generateCiWorkflow(choices: InitChoices): string {
  if (choices.ciTier === 'monorepo') {
    return `name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx turbo run typecheck test build --affected
`;
  }

  if (choices.language === 'python') {
    return `name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.13" }
      - run: pip install -r requirements.txt
      - run: pytest
`;
  }

  return `name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
      - run: npm run build
`;
}

export function generateDeployWorkflow(choices: InitChoices): string {
  return `name: Deploy
on:
  push: { branches: [main] }

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run build
      # Add deployment command for your target:
      # Vercel: npx vercel --prod --token=\${{ secrets.VERCEL_TOKEN }}
      # DO App Platform: doctl apps create-deployment \$APP_ID
      # Docker: docker build -t app . && docker push
      - run: echo "Configure deployment for ${choices.deploy}"
`;
}

export function generateReleaseWorkflow(): string {
  return `name: Release
on:
  push: { tags: ['v*'] }

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
`;
}

export function generateDependabot(): string {
  return `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    groups:
      dev-deps:
        dependency-type: development
      prod-deps:
        dependency-type: production
`;
}

export function generatePrTemplate(): string {
  return `## Summary
<!-- What does this PR do? -->

## Test plan
- [ ] Tests pass locally
- [ ] Manually verified

## Notes
<!-- Anything reviewers should know? -->
`;
}

export function generateBugTemplate(): string {
  return `---
name: Bug Report
about: Report a bug
labels: bug
---

## Expected behavior

## Actual behavior

## Steps to reproduce

## Environment
- OS:
- Node:
- Version:
`;
}

export function generateFeatureTemplate(): string {
  return `---
name: Feature Request
about: Suggest a feature
labels: enhancement
---

## Problem
<!-- What problem does this solve? -->

## Proposed solution

## Alternatives considered
`;
}
