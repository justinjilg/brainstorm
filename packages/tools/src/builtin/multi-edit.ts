import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { defineTool } from '../base.js';
import { applyEdits } from './edit-common.js';

export const multiEditTool = defineTool({
  name: 'multi_edit',
  description: 'Perform multiple find-and-replace edits in a single file atomically.',
  permission: 'confirm',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit'),
    edits: z.array(z.object({
      old_string: z.string().describe('Exact string to find'),
      new_string: z.string().describe('Replacement string'),
    })).describe('Array of find-and-replace operations'),
  }),
  async execute({ path, edits }) {
    if (!existsSync(path)) return { error: `File not found: ${path}` };

    const original = readFileSync(path, 'utf-8');
    const { content, results, appliedCount } = applyEdits(original, edits);

    if (appliedCount > 0) {
      const { getCheckpointManager } = await import('../checkpoint.js');
      const cp = getCheckpointManager();
      if (cp) cp.snapshot(path);
      writeFileSync(path, content, 'utf-8');
    }

    return { path, applied: appliedCount, total: edits.length, results };
  },
});
