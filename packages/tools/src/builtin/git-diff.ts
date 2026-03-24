import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description: 'Show changes between commits, the working tree, or the staging area.',
  permission: 'auto',
  inputSchema: z.object({
    staged: z.boolean().optional().describe('Show staged changes (default: unstaged)'),
    file: z.string().optional().describe('Limit diff to a specific file'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ staged, file, cwd }) {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (file) args.push('--', file);
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: cwd ?? process.cwd(),
        maxBuffer: 1024 * 1024 * 5,
      });
      return { diff: stdout.slice(0, 15000) || '(no changes)', truncated: stdout.length > 15000 };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
