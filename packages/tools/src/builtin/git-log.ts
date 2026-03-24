import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show recent commit history.',
  permission: 'auto',
  inputSchema: z.object({
    count: z.number().optional().describe('Number of commits to show (default: 20)'),
    file: z.string().optional().describe('Show history for a specific file'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ count, file, cwd }) {
    const args = ['log', '--oneline', '-n', String(count ?? 20)];
    if (file) args.push('--', file);
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: cwd ?? process.cwd() });
      return { log: stdout.trim() };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
