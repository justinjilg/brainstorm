import { loadProjectContext } from '@brainstorm/config';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SYSTEM_PROMPT = `You are Brainstorm, an AI coding assistant. You help users with software engineering tasks including writing code, debugging, refactoring, explaining code, and more.

When given a task:
1. Understand what the user needs
2. Use available tools to read files, search code, and gather context
3. Make changes using file write/edit tools
4. Verify your changes work

Be concise and direct. Write clean, idiomatic code. Follow existing patterns in the codebase.`;

export function buildSystemPrompt(projectPath: string): string {
  const parts = [DEFAULT_SYSTEM_PROMPT];

  // Project context from BRAINSTORM.md
  const projectContext = loadProjectContext(projectPath);
  if (projectContext) {
    parts.push(`\n## Project Context (from BRAINSTORM.md)\n\n${projectContext}`);
  }

  // Git context (if in a git repo)
  const gitContext = getGitContext(projectPath);
  if (gitContext) {
    parts.push(`\n## Git Context\n\n${gitContext}`);
  }

  return parts.join('\n');
}

function getGitContext(projectPath: string): string | null {
  // Check if it's a git repo
  if (!existsSync(join(projectPath, '.git'))) return null;

  try {
    const parts: string[] = [];

    // Current branch
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: projectPath, timeout: 3000 })
      .toString().trim();
    if (branch) parts.push(`Branch: ${branch}`);

    // Short status
    const status = execFileSync('git', ['status', '--short'], { cwd: projectPath, timeout: 3000 })
      .toString().trim();
    if (status) {
      const lines = status.split('\n');
      parts.push(`Working tree: ${lines.length} changed file${lines.length === 1 ? '' : 's'}`);
      // Show first 10 files
      parts.push(lines.slice(0, 10).join('\n'));
      if (lines.length > 10) parts.push(`... and ${lines.length - 10} more`);
    } else {
      parts.push('Working tree: clean');
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}
