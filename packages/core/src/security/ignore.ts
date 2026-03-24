import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Default patterns for .brainstormignore — files that should never be
 * read or sent to LLM providers.
 */
const DEFAULT_IGNORE_PATTERNS = [
  // Secrets and credentials
  '.env', '.env.*', '.env.local', '.env.production',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks',
  'credentials.json', 'service-account.json',
  '.npmrc', '.pypirc',

  // SSH and auth
  '.ssh/', '.gnupg/', '.aws/', '.gcloud/',

  // Build artifacts and dependencies
  'node_modules/', 'dist/', 'build/', '.next/', '.turbo/',
  '__pycache__/', '*.pyc', '.venv/', 'venv/',
  'target/', '.gradle/',

  // Binary files
  '*.exe', '*.dll', '*.so', '*.dylib',
  '*.zip', '*.tar', '*.gz', '*.rar',
  '*.jpg', '*.jpeg', '*.png', '*.gif', '*.mp4', '*.mp3',
  '*.woff', '*.woff2', '*.ttf', '*.eot',

  // IDE and OS
  '.idea/', '.vscode/settings.json',
  '.DS_Store', 'Thumbs.db',

  // Lock files (large, not useful for context)
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'poetry.lock', 'Gemfile.lock',
];

/**
 * Load ignore patterns from .brainstormignore + defaults.
 */
export function loadIgnorePatterns(projectPath: string): string[] {
  const patterns = [...DEFAULT_IGNORE_PATTERNS];

  const ignoreFile = join(projectPath, '.brainstormignore');
  if (existsSync(ignoreFile)) {
    const custom = readFileSync(ignoreFile, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    patterns.push(...custom);
  }

  return patterns;
}

/**
 * Check if a file path matches any ignore pattern.
 */
export function isIgnored(filePath: string, projectPath: string, patterns: string[]): boolean {
  const rel = relative(projectPath, filePath);
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      // Directory pattern
      if (rel.startsWith(pattern) || rel.includes('/' + pattern)) return true;
    } else if (pattern.startsWith('*.')) {
      // Extension pattern
      if (rel.endsWith(pattern.slice(1))) return true;
    } else {
      // Exact match or contains
      if (rel === pattern || rel.endsWith('/' + pattern) || rel.includes(pattern)) return true;
    }
  }
  return false;
}
