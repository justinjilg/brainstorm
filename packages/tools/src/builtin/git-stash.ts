import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const gitStashTool = defineTool({
  name: 'git_stash',
  description:
    'Manage git stash — push changes to stash, pop/apply from stash, or list stashed entries. Useful before switching branches with uncommitted work.',
  permission: 'confirm',
  inputSchema: z.object({
    action: z.enum(['push', 'pop', 'apply', 'list', 'drop']).describe('Stash action'),
    message: z.string().optional().describe('Stash message (for "push")'),
    index: z.number().optional().describe('Stash index (for pop/apply/drop, default: 0)'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ action, message, index, cwd }) {
    const opts = { cwd: cwd ?? process.cwd() };

    try {
      switch (action) {
        case 'push': {
          const args = ['stash', 'push'];
          if (message) args.push('-m', message);
          const { stdout } = await execFileAsync('git', args, opts);
          return { success: true, output: stdout.trim() };
        }
        case 'pop': {
          const ref = `stash@{${index ?? 0}}`;
          const { stdout } = await execFileAsync('git', ['stash', 'pop', ref], opts);
          return { success: true, output: stdout.trim() };
        }
        case 'apply': {
          const ref = `stash@{${index ?? 0}}`;
          const { stdout } = await execFileAsync('git', ['stash', 'apply', ref], opts);
          return { success: true, output: stdout.trim() };
        }
        case 'list': {
          const { stdout } = await execFileAsync('git', ['stash', 'list'], opts);
          const entries = stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const match = line.match(/^(stash@\{\d+\}):\s*(.+)$/);
              return match ? { ref: match[1], description: match[2] } : { ref: '', description: line };
            });
          return { entries, count: entries.length };
        }
        case 'drop': {
          const ref = `stash@{${index ?? 0}}`;
          const { stdout } = await execFileAsync('git', ['stash', 'drop', ref], opts);
          return { success: true, output: stdout.trim() };
        }
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
