import { z } from 'zod';
import fg from 'fast-glob';
import { defineTool } from '../base.js';

export const globTool = defineTool({
  name: 'glob',
  description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time.',
  permission: 'auto',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().optional().describe('Directory to search in (default: current directory)'),
  }),
  async execute({ pattern, cwd }) {
    const files = await fg(pattern, {
      cwd: cwd ?? process.cwd(),
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      stats: true,
    });

    const sorted = files
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .map((f) => f.path);

    return { files: sorted, count: sorted.length };
  },
});
