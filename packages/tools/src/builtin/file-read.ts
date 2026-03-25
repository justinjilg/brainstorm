import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { defineTool } from '../base.js';

import { homedir } from 'node:os';

function ensureSafePath(filePath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  // Allow: paths within cwd OR within home directory
  // Block: system paths (/etc, /usr, /var, /proc, /sys, /dev)
  const BLOCKED_PREFIXES = ['/etc', '/usr', '/var', '/proc', '/sys', '/dev', '/sbin', '/boot'];
  if (BLOCKED_PREFIXES.some((p) => resolved.startsWith(p))) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }

  // Allow absolute paths within home dir or within cwd
  const isInHome = resolved.startsWith(home);
  const isInCwd = !relative(cwd, resolved).startsWith('..');
  if (!isInHome && !isInCwd) {
    throw new Error(`Path blocked: "${filePath}" is outside home directory and workspace`);
  }

  return resolved;
}

export const fileReadTool = defineTool({
  name: 'file_read',
  description: 'Read the contents of a file. Supports absolute paths within the home directory (~/Projects, ~/Desktop, etc.) and relative paths within the project. Use `limit` and `offset` for large files — default reads the full file. Returns { content, totalLines } on success, { error } on failure.',
  permission: 'auto',
  inputSchema: z.object({
    path: z.string().describe('Absolute or relative path to the file to read'),
    limit: z.number().optional().describe('Maximum number of lines to read'),
    offset: z.number().optional().describe('Line number to start reading from (1-based)'),
  }),
  async execute({ path, limit, offset }) {
    let safePath: string;
    try { safePath = ensureSafePath(path); } catch (e: any) { return { error: e.message }; }

    if (!existsSync(safePath)) {
      return { error: `File not found: ${path}` };
    }
    const content = readFileSync(safePath, 'utf-8');
    const lines = content.split('\n');

    const start = (offset ?? 1) - 1;
    const end = limit ? start + limit : lines.length;
    const selected = lines.slice(start, end);

    return {
      content: selected.map((line, i) => `${start + i + 1}\t${line}`).join('\n'),
      totalLines: lines.length,
    };
  },
});
