import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createConnection } from 'node:net';

export interface ProjectDetection {
  name: string;
  type: 'monorepo' | 'app' | 'cli' | 'library' | 'api' | null;
  language: 'typescript' | 'python' | 'rust' | 'go' | null;
  framework: 'nextjs' | 'hono' | 'fastapi' | 'express' | 'none' | null;
  runtime: 'node' | 'python' | 'go' | 'bun' | 'deno' | null;

  // Existing files
  hasGit: boolean;
  hasStormMd: boolean;
  hasBrainstormMd: boolean;
  hasClaudeMd: boolean;
  hasGitignore: boolean;
  hasGithubWorkflows: boolean;
  hasEnvExample: boolean;
  hasPrettierrc: boolean;
  hasBrainstormToml: boolean;

  // Package info
  packageName: string | null;
  scripts: Record<string, string>;

  // Local model runtimes
  localModels: Array<'ollama' | 'lmstudio' | 'llamacpp'>;
}

/**
 * Scan the project directory and detect what exists.
 * Zero interaction — purely reads filesystem and probes ports.
 */
export async function detectProject(projectDir: string): Promise<ProjectDetection> {
  const detection: ProjectDetection = {
    name: basename(projectDir),
    type: null,
    language: null,
    framework: null,
    runtime: null,
    hasGit: existsSync(join(projectDir, '.git')),
    hasStormMd: existsSync(join(projectDir, 'STORM.md')),
    hasBrainstormMd: existsSync(join(projectDir, 'BRAINSTORM.md')),
    hasClaudeMd: existsSync(join(projectDir, 'CLAUDE.md')),
    hasGitignore: existsSync(join(projectDir, '.gitignore')),
    hasGithubWorkflows: existsSync(join(projectDir, '.github', 'workflows')),
    hasEnvExample: existsSync(join(projectDir, '.env.example')),
    hasPrettierrc: existsSync(join(projectDir, '.prettierrc')),
    hasBrainstormToml: existsSync(join(projectDir, 'brainstorm.toml')),
    packageName: null,
    scripts: {},
    localModels: [],
  };

  // Read package.json
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      detection.packageName = pkg.name ?? null;
      if (detection.packageName) detection.name = detection.packageName;
      detection.scripts = pkg.scripts ?? {};
      detection.language = 'typescript'; // Node project
      detection.runtime = 'node';

      // Detect monorepo
      if (pkg.workspaces || existsSync(join(projectDir, 'turbo.json')) || existsSync(join(projectDir, 'pnpm-workspace.yaml'))) {
        detection.type = 'monorepo';
      }

      // Detect framework from deps
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps?.next) detection.framework = 'nextjs';
      else if (allDeps?.hono) detection.framework = 'hono';
      else if (allDeps?.express) detection.framework = 'express';

      // Detect CLI
      if (pkg.bin) detection.type = detection.type ?? 'cli';

      // Detect library
      if (pkg.exports || pkg.main) detection.type = detection.type ?? 'library';
    } catch { /* invalid package.json */ }
  }

  // Detect framework from config files
  if (!detection.framework) {
    if (existsSync(join(projectDir, 'next.config.ts')) || existsSync(join(projectDir, 'next.config.js')) || existsSync(join(projectDir, 'next.config.mjs'))) {
      detection.framework = 'nextjs';
    } else if (existsSync(join(projectDir, 'vite.config.ts')) || existsSync(join(projectDir, 'vite.config.js'))) {
      detection.framework = 'none'; // Vite but no specific framework signal
    }
  }

  // Detect Python
  if (existsSync(join(projectDir, 'pyproject.toml')) || existsSync(join(projectDir, 'requirements.txt'))) {
    detection.language = 'python';
    detection.runtime = 'python';
    // Check for FastAPI
    try {
      const content = readFileSync(join(projectDir, 'requirements.txt'), 'utf-8');
      if (content.includes('fastapi')) detection.framework = 'fastapi';
    } catch { /* no requirements.txt */ }
    detection.type = detection.type ?? 'api';
  }

  // Detect Rust
  if (existsSync(join(projectDir, 'Cargo.toml'))) {
    detection.language = 'rust';
    detection.type = detection.type ?? 'cli';
  }

  // Detect Go
  if (existsSync(join(projectDir, 'go.mod'))) {
    detection.language = 'go';
    detection.runtime = 'go';
    detection.type = detection.type ?? 'api';
  }

  // Default type
  detection.type = detection.type ?? 'app';

  // Probe local model runtimes (non-blocking, fast timeout)
  const probes = await Promise.allSettled([
    probePort(11434).then((ok) => ok ? 'ollama' as const : null),
    probePort(1234).then((ok) => ok ? 'lmstudio' as const : null),
    probePort(8080).then((ok) => ok ? 'llamacpp' as const : null),
  ]);

  for (const result of probes) {
    if (result.status === 'fulfilled' && result.value) {
      detection.localModels.push(result.value);
    }
  }

  return detection;
}

/** Probe a localhost port with a 500ms timeout. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 500 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}
