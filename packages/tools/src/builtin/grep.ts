import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const grepTool = defineTool({
  name: 'grep',
  description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
  permission: 'auto',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search (default: current directory)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
    maxResults: z.number().optional().describe('Maximum number of results (default: 50)'),
  }),
  async execute({ pattern, path, glob: fileGlob, maxResults }) {
    const args = ['--no-heading', '--line-number', '--color', 'never', '-m', String(maxResults ?? 50)];
    if (fileGlob) args.push('--glob', fileGlob);
    args.push(pattern);
    args.push(path ?? '.');

    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: process.cwd(),
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const lines = stdout.trim().split('\n').filter(Boolean);
      return { matches: lines.slice(0, maxResults ?? 50), count: lines.length };
    } catch (err: any) {
      // rg exits with code 1 when no matches found — that's not an error
      if (err.code === 1) return { matches: [], count: 0 };
      // rg not installed, fall back to grep
      if (err.code === 'ENOENT') {
        return { error: 'ripgrep (rg) not found. Install it: brew install ripgrep' };
      }
      return { error: err.message };
    }
  },
});
