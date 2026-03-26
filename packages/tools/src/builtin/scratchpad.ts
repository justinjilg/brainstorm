import { z } from 'zod';
import { defineTool } from '../base.js';

/**
 * Session scratchpad — compaction-resistant notes.
 * Singleton lives here in tools to avoid circular deps with core.
 * Core reads via getScratchpad() export.
 */
const entries = new Map<string, string>();

export function getScratchpadEntries(): Map<string, string> {
  return entries;
}

export function clearScratchpad(): void {
  entries.clear();
}

export function formatScratchpadContext(): string {
  if (entries.size === 0) return '';
  const items = [...entries].map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `[Scratchpad — preserved through compaction]\n${items}`;
}

export const scratchpadWriteTool = defineTool({
  name: 'scratchpad_write',
  description: 'Save a note that survives context compaction. Use for: key decisions, current task state, important constraints. Not for code — for context you must remember.',
  permission: 'auto',
  inputSchema: z.object({
    key: z.string().describe('Note identifier (e.g., "current_task", "decision_drizzle_over_prisma")'),
    value: z.string().describe('The note content'),
  }),
  async execute({ key, value }) {
    entries.set(key, value);
    return { success: true, key, totalNotes: entries.size };
  },
});

export const scratchpadReadTool = defineTool({
  name: 'scratchpad_read',
  description: 'Read scratchpad notes. Omit key to read all notes.',
  permission: 'auto',
  inputSchema: z.object({
    key: z.string().optional().describe('Specific note to read (optional — omit to read all)'),
  }),
  async execute({ key }) {
    if (key) {
      const val = entries.get(key);
      if (!val) return { error: `Note "${key}" not found.` };
      return { key, value: val };
    }
    return { notes: Object.fromEntries(entries) };
  },
});
