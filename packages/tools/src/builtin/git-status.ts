import { z } from 'zod';
import { defineTool } from '../base.js';
import { runGit } from './git-common.js';

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show the working tree status (modified, staged, untracked files).',
  permission: 'auto',
  inputSchema: z.object({
    cwd: z.string().optional().describe('Working directory (default: current)'),
  }),
  async execute({ cwd }) {
    const result = await runGit(['status', '--short'], cwd);
    if (result.exitCode !== 0) {
      return { status: 'Not a git repository', isGitRepo: false };
    }
    return { status: result.stdout.trim() || '(clean working tree)', isGitRepo: true };
  },
});
