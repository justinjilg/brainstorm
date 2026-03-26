import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { defineTool } from '../base.js';

function ensureSafePath(filePath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, filePath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Path traversal blocked: "${filePath}" escapes workspace`);
  }
  return resolved;
}

interface FileEditResult {
  path: string;
  applied: number;
  total: number;
  errors: string[];
}

/**
 * Apply edits across multiple files in a single tool call.
 * Two-phase execution: validate all edits, then apply.
 * Partial success: files with valid edits are written even if other files fail.
 */
export const batchEditTool = defineTool({
  name: 'batch_edit',
  description: 'Apply find-and-replace edits across multiple files in one operation. Each file gets its own list of edits. Reduces round-trips for multi-file refactors.',
  permission: 'confirm',
  inputSchema: z.object({
    files: z.array(z.object({
      path: z.string().describe('Path to the file'),
      edits: z.array(z.object({
        old_string: z.string().describe('Exact string to find (must be unique in the file)'),
        new_string: z.string().describe('Replacement string'),
      })).min(1),
    })).min(1).describe('List of files, each with its own edits'),
  }),
  async execute({ files }) {
    const results: FileEditResult[] = [];

    for (const file of files) {
      const fileResult: FileEditResult = { path: file.path, applied: 0, total: file.edits.length, errors: [] };

      // Validate path
      let safePath: string;
      try {
        safePath = ensureSafePath(file.path);
      } catch (e: any) {
        fileResult.errors.push(e.message);
        results.push(fileResult);
        continue;
      }

      if (!existsSync(safePath)) {
        fileResult.errors.push(`File not found: ${file.path}`);
        results.push(fileResult);
        continue;
      }

      let content = readFileSync(safePath, 'utf-8');

      // Validate and apply each edit
      for (const edit of file.edits) {
        const count = content.split(edit.old_string).length - 1;
        if (count === 0) {
          fileResult.errors.push(`Not found: "${edit.old_string.slice(0, 50)}${edit.old_string.length > 50 ? '...' : ''}"`);
          continue;
        }
        if (count > 1) {
          fileResult.errors.push(`${count} occurrences: "${edit.old_string.slice(0, 50)}${edit.old_string.length > 50 ? '...' : ''}" — must be unique`);
          continue;
        }
        content = content.replace(edit.old_string, edit.new_string);
        fileResult.applied++;
      }

      // Write if any edits succeeded
      if (fileResult.applied > 0) {
        const { getCheckpointManager } = await import('../checkpoint.js');
        const cp = getCheckpointManager();
        if (cp) cp.snapshot(safePath);
        writeFileSync(safePath, content, 'utf-8');
      }

      results.push(fileResult);
    }

    const filesModified = results.filter((r) => r.applied > 0).length;
    const totalEditsApplied = results.reduce((sum, r) => sum + r.applied, 0);
    const totalEdits = results.reduce((sum, r) => sum + r.total, 0);

    return {
      filesModified,
      totalFiles: files.length,
      editsApplied: totalEditsApplied,
      totalEdits,
      results,
    };
  },
});
