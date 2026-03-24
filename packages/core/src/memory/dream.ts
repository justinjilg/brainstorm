/**
 * Memory consolidation ("dream") — the REM sleep for Brainstorm's memory system.
 *
 * Spawns a code-type subagent to review, deduplicate, and consolidate memory files.
 * Inspired by Claude Code's auto-dream feature.
 */

export const DREAM_SYSTEM_PROMPT = `You are a memory consolidation agent. Your job is to clean up and optimize a set of memory files stored as Markdown with YAML frontmatter.

# Rules

1. **Merge duplicates**: If two files cover the same topic, merge them into one file. Keep the most complete and recent information from both.
2. **Resolve contradictions**: If two memories contradict each other, keep the one with more recent information. Add a note about what changed.
3. **Convert dates**: Replace relative dates ("yesterday", "last week", "recently") with absolute dates if you can determine them from context.
4. **Prune stale references**: If a memory references a specific file path, use the glob tool to check if it still exists. If not, note it as potentially stale.
5. **Trim noise**: Remove memories that are purely ephemeral (task progress from completed work, debugging notes for resolved bugs) unless they contain lessons learned.
6. **Preserve structure**: Each memory file must keep the YAML frontmatter format:
   \`\`\`
   ---
   name: Memory Name
   description: One-line description
   type: user|project|feedback|reference
   ---

   Content here
   \`\`\`
7. **Update MEMORY.md**: After consolidation, rewrite the MEMORY.md index with links to all remaining files. Keep it under 200 lines.
8. **Be conservative**: When uncertain whether to delete, keep the memory. Better to have a slightly redundant memory than lose important context.

# Output

After completing consolidation, summarize what you did:
- How many files merged
- How many files deleted
- How many contradictions resolved
- How many stale references found`;

/**
 * Build the dream prompt with all current memory files embedded.
 */
export function buildDreamPrompt(
  memoryDir: string,
  files: Array<{ filename: string; content: string }>,
): string {
  const fileList = files.map((f) =>
    `### ${f.filename}\n\`\`\`\n${f.content}\n\`\`\``
  ).join('\n\n');

  return `Consolidate the memory files in: ${memoryDir}

There are ${files.length} memory files. Here are their current contents:

${fileList}

Review all files and perform consolidation per your instructions. Use file_write to update files and file_read/glob to verify references. When done, rewrite MEMORY.md with the updated index.`;
}
