import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface GenerateResult {
  action: 'created' | 'skipped' | 'merged';
  path: string;
}

/**
 * Write a file if it doesn't exist. Returns the action taken.
 * Creates parent directories as needed.
 */
export function generateFile(
  projectDir: string,
  relativePath: string,
  content: string,
  options: { force?: boolean } = {},
): GenerateResult {
  const fullPath = join(projectDir, relativePath);
  const dir = dirname(fullPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(fullPath) && !options.force) {
    return { action: 'skipped', path: relativePath };
  }

  writeFileSync(fullPath, content, 'utf-8');
  return { action: 'created', path: relativePath };
}

/**
 * Merge patterns into an existing .gitignore.
 * Appends missing patterns with a comment block. Never removes existing patterns.
 */
export function mergeGitignore(
  projectDir: string,
  newContent: string,
): GenerateResult {
  const fullPath = join(projectDir, '.gitignore');

  if (!existsSync(fullPath)) {
    writeFileSync(fullPath, newContent, 'utf-8');
    return { action: 'created', path: '.gitignore' };
  }

  const existing = readFileSync(fullPath, 'utf-8');
  const existingPatterns = new Set(
    existing.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
  );

  const newPatterns = newContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => !existingPatterns.has(l));

  if (newPatterns.length === 0) {
    return { action: 'skipped', path: '.gitignore' };
  }

  const appendBlock = '\n# Added by brainstorm init\n' + newPatterns.join('\n') + '\n';
  writeFileSync(fullPath, existing.trimEnd() + '\n' + appendBlock, 'utf-8');
  return { action: 'merged', path: '.gitignore' };
}
