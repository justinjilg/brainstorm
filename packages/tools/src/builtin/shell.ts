import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const shellTool = defineTool({
  name: 'shell',
  description: 'Execute a shell command and return its stdout, stderr, and exit code. Use for running tests, builds, git operations, etc.',
  permission: 'confirm',
  inputSchema: z.object({
    command: z.string().describe('The command to execute (passed to /bin/sh -c)'),
    cwd: z.string().optional().describe('Working directory for the command'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default 30000)'),
  }),
  async execute({ command, cwd, timeout }) {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: cwd ?? process.cwd(),
        timeout: timeout ?? 30_000,
        maxBuffer: 1024 * 1024 * 10,
      });
      return { stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 5000), exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: (err.stdout ?? '').slice(0, 10000),
        stderr: (err.stderr ?? err.message ?? '').slice(0, 5000),
        exitCode: err.code ?? 1,
      };
    }
  },
});
