import { loadProjectContext } from '@brainstorm/config';

const DEFAULT_SYSTEM_PROMPT = `You are Brainstorm, an AI coding assistant. You help users with software engineering tasks including writing code, debugging, refactoring, explaining code, and more.

When given a task:
1. Understand what the user needs
2. Use available tools to read files, search code, and gather context
3. Make changes using file write/edit tools
4. Verify your changes work

Be concise and direct. Write clean, idiomatic code. Follow existing patterns in the codebase.`;

export function buildSystemPrompt(projectPath: string): string {
  const parts = [DEFAULT_SYSTEM_PROMPT];

  const projectContext = loadProjectContext(projectPath);
  if (projectContext) {
    parts.push(`\n## Project Context (from BRAINSTORM.md)\n\n${projectContext}`);
  }

  return parts.join('\n');
}
