import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineTool } from '../base.js';

export const fileWriteTool = defineTool({
  name: 'file_write',
  description: 'Write content to a file, creating it if it does not exist. Creates parent directories as needed.',
  permission: 'confirm',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to write'),
    content: z.string().describe('The content to write to the file'),
  }),
  async execute({ path, content }) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    return { success: true, path, bytesWritten: Buffer.byteLength(content) };
  },
});
