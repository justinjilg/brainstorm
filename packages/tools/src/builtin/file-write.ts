import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
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

export const fileWriteTool = defineTool({
  name: 'file_write',
  description: 'Write content to a file, creating it if it does not exist. Creates parent directories as needed.',
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
