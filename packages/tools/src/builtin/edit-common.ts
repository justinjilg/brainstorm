/**
 * Shared edit logic used by file_edit, multi_edit, and batch_edit.
 * Centralizes the find-count-replace pattern to avoid duplication.
 */

export interface EditResult {
  applied: boolean;
  content?: string;
  error?: string;
  occurrences?: number;
}

/**
 * Apply a single string replacement to content.
 * Returns the updated content if successful, or an error message if not.
 */
export function applyEdit(content: string, oldString: string, newString: string): EditResult {
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    return { applied: false, error: 'not found' };
  }
  if (occurrences > 1) {
    return { applied: false, error: `${occurrences} occurrences (must be unique)`, occurrences };
  }

  return {
    applied: true,
    content: content.replace(oldString, newString),
  };
}

/**
 * Apply multiple edits to content sequentially.
 * Returns the final content and per-edit results.
 */
export function applyEdits(
  content: string,
  edits: Array<{ old_string: string; new_string: string }>,
): { content: string; results: Array<{ old: string; applied: boolean; reason?: string }>; appliedCount: number } {
  let current = content;
  const results: Array<{ old: string; applied: boolean; reason?: string }> = [];
  let appliedCount = 0;

  for (const edit of edits) {
    const result = applyEdit(current, edit.old_string, edit.new_string);
    if (result.applied && result.content) {
      current = result.content;
      results.push({ old: edit.old_string.slice(0, 40), applied: true });
      appliedCount++;
    } else {
      results.push({ old: edit.old_string.slice(0, 40), applied: false, reason: result.error });
    }
  }

  return { content: current, results, appliedCount };
}
