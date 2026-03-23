import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { defineTool } from '../base.js';

export const fileEditTool = defineTool({
  name: 'file_edit',
  description: 'Perform a surgical string replacement in a file. The old_string must match exactly one location in the file.',
  permission: 'confirm',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit'),
    old_string: z.string().describe('The exact string to find and replace'),
    new_string: z.string().describe('The replacement string'),
  }),
  async execute({ path, old_string, new_string }) {
    if (!existsSync(path)) {
      return { error: `File not found: ${path}` };
    }
    const content = readFileSync(path, 'utf-8');
    const occurrences = content.split(old_string).length - 1;

    if (occurrences === 0) {
      return { error: 'old_string not found in file' };
    }
    if (occurrences > 1) {
      return { error: `old_string found ${occurrences} times — must be unique. Provide more surrounding context.` };
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(path, updated, 'utf-8');
    return { success: true, path };
  },
});
