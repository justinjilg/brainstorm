import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { defineTool } from '../base.js';

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

    let content = readFileSync(path, 'utf-8');
    const results: Array<{ old: string; applied: boolean; reason?: string }> = [];

    for (const edit of edits) {
      const count = content.split(edit.old_string).length - 1;
      if (count === 0) {
        results.push({ old: edit.old_string.slice(0, 40), applied: false, reason: 'not found' });
        continue;
      }
      if (count > 1) {
        results.push({ old: edit.old_string.slice(0, 40), applied: false, reason: `${count} occurrences (must be unique)` });
        continue;
      }
      content = content.replace(edit.old_string, edit.new_string);
      results.push({ old: edit.old_string.slice(0, 40), applied: true });
    }

    const applied = results.filter((r) => r.applied).length;
    if (applied > 0) {
      const { getCheckpointManager } = await import('../checkpoint.js');
      const cp = getCheckpointManager();
      if (cp) cp.snapshot(path);
      writeFileSync(path, content, 'utf-8');
    }

    return { path, applied, total: edits.length, results };
  },
});
