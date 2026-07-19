import { z } from 'zod';
import { defineTool } from '../base.js';
import { getSessionId } from '../session-context.js';

/**
 * Per-session scratchpad — compaction-resistant notes. Previously a single
 * process-global Map: concurrent sessions read/overwrote each other's notes,
 * and compaction (which reads this) could inject one session's scratchpad into
 * ANOTHER session's model context. Keyed by session id, with an LRU bound.
 * Core reads via getScratchpadEntries()/formatScratchpadContext() during the
 * session scope, so getSessionId() resolves correctly.
 */
const MAX_TRACKED_SESSIONS = 256;
const scratchpads = new Map<string, Map<string, string>>();

function entriesFor(sessionId: string): Map<string, string> {
  let e = scratchpads.get(sessionId);
  if (!e) {
    if (scratchpads.size >= MAX_TRACKED_SESSIONS) {
      const oldest = scratchpads.keys().next().value;
      if (oldest !== undefined) scratchpads.delete(oldest);
    }
    e = new Map();
    scratchpads.set(sessionId, e);
  }
  return e;
}

export function getScratchpadEntries(): Map<string, string> {
  return entriesFor(getSessionId());
}

export function clearScratchpad(sessionId: string = getSessionId()): void {
  scratchpads.delete(sessionId);
}

export function formatScratchpadContext(): string {
  const entries = entriesFor(getSessionId());
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
    const entries = entriesFor(getSessionId());
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
    const entries = entriesFor(getSessionId());
    if (key) {
      const val = entries.get(key);
      if (!val) return { error: `Note "${key}" not found.` };
      return { key, value: val };
    }
    return { notes: Object.fromEntries(entries) };
  },
});
