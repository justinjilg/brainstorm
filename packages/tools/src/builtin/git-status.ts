import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show the working tree status (modified, staged, untracked files).',
  permission: 'auto',
  inputSchema: z.object({
    cwd: z.string().optional().describe('Working directory (default: current)'),
  }),
  async execute({ cwd }) {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: cwd ?? process.cwd() });
      return { status: stdout.trim() || '(clean working tree)', isGitRepo: true };
    } catch {
      return { status: 'Not a git repository', isGitRepo: false };
    }
  },
});
