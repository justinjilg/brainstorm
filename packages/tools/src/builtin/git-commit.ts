import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description: 'Stage files and create a git commit. Always requires explicit approval.',
  permission: 'confirm',
  inputSchema: z.object({
    message: z.string().describe('Commit message'),
    files: z.array(z.string()).optional().describe('Files to stage (default: all modified)'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ message, files, cwd }) {
    const opts = { cwd: cwd ?? process.cwd() };
    try {
      // Stage files
      if (files && files.length > 0) {
        await execFileAsync('git', ['add', ...files], opts);
      } else {
        await execFileAsync('git', ['add', '-A'], opts);
      }
      // Commit
      const { stdout } = await execFileAsync('git', ['commit', '-m', message], opts);
      return { success: true, output: stdout.trim() };
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
