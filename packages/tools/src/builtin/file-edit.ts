import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '../base.js';

function ensureSafePath(filePath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  const BLOCKED_PREFIXES = ['/etc', '/usr', '/var', '/proc', '/sys', '/dev', '/sbin', '/boot'];
  if (BLOCKED_PREFIXES.some((p) => resolved.startsWith(p))) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }

  const isInHome = resolved.startsWith(home);
  const isInCwd = !relative(cwd, resolved).startsWith('..');
  if (!isInHome && !isInCwd) {
    throw new Error(`Path blocked: "${filePath}" is outside home directory and workspace`);
  }

  return resolved;
}

export const fileEditTool = defineTool({
  name: 'file_edit',
  description: 'Perform a surgical string replacement in a file. The old_string must match exactly one location. Returns { success, replacements } or { error }. Supports absolute paths within home directory.',
  permission: 'confirm',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit'),
    old_string: z.string().describe('The exact string to find and replace'),
    new_string: z.string().describe('The replacement string'),
  }),
  async execute({ path, old_string, new_string }) {
    let safePath: string;
    try { safePath = ensureSafePath(path); } catch (e: any) { return { error: e.message }; }

    if (!existsSync(safePath)) {
      return { error: `File not found: ${path}` };
    }
    const content = readFileSync(safePath, 'utf-8');
    const occurrences = content.split(old_string).length - 1;

    if (occurrences === 0) {
      return { error: 'old_string not found in file' };
    }
    if (occurrences > 1) {
      return { error: `old_string found ${occurrences} times — must be unique. Provide more surrounding context.` };
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(safePath, updated, 'utf-8');
    return { success: true, path };
  },
});
