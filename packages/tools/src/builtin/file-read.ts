import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { defineTool } from '../base.js';

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
    if (!existsSync(path)) {
      return { error: `File not found: ${path}` };
    }
    let content = readFileSync(path, 'utf-8');
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
