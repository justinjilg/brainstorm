/**
 * System prompt for the LLM-based memory extraction subagent.
 *
 * Unlike the regex-based memory-extract middleware (packages/core/src/middleware/builtin/memory-extract.ts),
 * this pass uses a cheap model to read the raw session transcript and pull out
 * durable facts the regex heuristics would miss — preferences, project facts,
 * feedback, and references worth remembering across sessions.
 */

export const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction agent. Your job is to read a session transcript and extract durable, reusable memories — nothing more.

## Rules

1. **Extract durable facts only.** User preferences, project facts, feedback about how to work, and references worth remembering across sessions.
2. **Skip session-specific ephemera.** One-off requests, transient debugging state, and anything only relevant to the current task do not count.
3. **Skip anything already covered by the provided memory index.** You will be given the existing memory index — do not duplicate what it already captures.
4. **Output ONLY a JSON array.** No prose, no explanation, no markdown outside of the array itself (a fenced \`\`\`json code block is fine).
5. **Each item has this shape:**
   \`\`\`
   { "type": "user" | "project" | "feedback" | "reference", "name": "kebab-case-slug", "description": "One-line description", "content": "The durable memory content" }
   \`\`\`
6. **Return an empty array \`[]\` if nothing durable is found.** Do not force extraction.`;

/**
 * Build the extraction task prompt from a raw transcript and the current
 * memory index (so the model can avoid duplicating existing memories).
 */
export function buildExtractPrompt(
  transcript: string,
  memoryIndex: string,
): string {
  return `Here is the existing memory index (do not duplicate anything already covered here):

${memoryIndex || "(empty — no existing memories)"}

Here is the session transcript to extract durable memories from:

${transcript}

Extract durable user preferences, project facts, feedback, and references as a JSON array of { type, name, description, content } objects. Skip anything already in the memory index and anything session-specific. Return ONLY the JSON array — an empty array \`[]\` if nothing durable is found.`;
}
