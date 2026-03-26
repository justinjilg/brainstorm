import { z } from 'zod';
import { defineTool } from '../base.js';
import { getCheckpointManager } from '../checkpoint.js';

export const undoTool = defineTool({
  name: 'undo_last_write',
  description: 'Revert the most recent file write or edit. Optionally specify a file path to revert only that file. Returns { success, revertedFile } or { error }.',
  permission: 'confirm',
  inputSchema: z.object({
    path: z.string().optional().describe('Specific file to revert (optional — defaults to most recent write)'),
  }),
  async execute({ path }) {
    const cp = getCheckpointManager();
    if (!cp) {
      return { error: 'Checkpoint system not initialized. No undo history available.' };
    }

    const reverted = cp.revertLast(path);
    if (!reverted) {
      return { error: path ? `No checkpoint found for ${path}` : 'No checkpoints to revert.' };
    }

    return { success: true, revertedFile: reverted };
  },
});
