import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { defineTool } from '../base.js';

import { homedir } from 'node:os';

function ensureSafePath(filePath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  // Block system paths
  const BLOCKED_PREFIXES = ['/etc', '/usr', '/var', '/proc', '/sys', '/dev', '/sbin', '/boot'];
  if (BLOCKED_PREFIXES.some((p) => resolved.startsWith(p))) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }

  // Allow within home dir or within cwd
  const isInHome = resolved.startsWith(home);
  const isInCwd = !relative(cwd, resolved).startsWith('..');
  if (!isInHome && !isInCwd) {
    throw new Error(`Path blocked: "${filePath}" is outside home directory and workspace`);
  }

  return resolved;
}

export const fileWriteTool = defineTool({
  name: 'file_write',
  description: 'Write content to a file, creating it if it does not exist. Creates parent directories as needed. Supports absolute paths within home directory. Returns { success, path, bytesWritten } on success, { error } on failure.',
  permission: 'confirm',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to write'),
    content: z.string().describe('The content to write to the file'),
  }),
  async execute({ path, content }) {
    let safePath: string;
    try { safePath = ensureSafePath(path); } catch (e: any) { return { error: e.message }; }

    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, content, 'utf-8');
    return { success: true, path, bytesWritten: Buffer.byteLength(content) };
  },
});
