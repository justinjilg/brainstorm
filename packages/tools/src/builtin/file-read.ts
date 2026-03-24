import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { defineTool } from '../base.js';

function ensureSafePath(filePath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, filePath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Path traversal blocked: "${filePath}" escapes workspace`);
  }
  return resolved;
}

export const fileReadTool = defineTool({
  name: 'file_read',
  description: 'Read the contents of a file at the given path. Returns the file content as a string.',
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
