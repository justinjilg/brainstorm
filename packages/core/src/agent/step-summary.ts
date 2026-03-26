/**
 * Step Summarization — async one-line summaries for TUI display.
 *
 * After each agent step, generates a concise summary + activity tag
 * using a cheap model. Runs async (fire-and-forget) to avoid blocking.
 *
 * Inspired by Trae Agent's Lakeview step summarization system.
 */

export type ActivityTag =
  | 'READING'
  | 'WRITING'
  | 'TESTING'
  | 'DEBUGGING'
  | 'PLANNING'
  | 'SEARCHING'
  | 'REVIEWING'
  | 'COMMITTING';

export interface StepSummary {
  /** One-line summary (max 80 chars). */
  summary: string;
  /** Activity classification tag. */
  tag: ActivityTag;
  /** Step number. */
  step: number;
  /** Timestamp. */
  timestamp: number;
}

/** Classify a tool call into an activity tag. */
export function classifyActivity(toolName: string): ActivityTag {
  switch (toolName) {
    case 'file_read':
    case 'glob':
    case 'list_dir':
      return 'READING';

    case 'file_write':
    case 'file_edit':
    case 'multi_edit':
    case 'batch_edit':
      return 'WRITING';

    case 'grep':
    case 'web_search':
    case 'web_fetch':
      return 'SEARCHING';

    case 'git_commit':
    case 'gh_pr':
      return 'COMMITTING';

    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return 'REVIEWING';

    default:
      if (toolName.startsWith('br_')) return 'PLANNING';
      return 'READING';
  }
}

/**
 * Generate a quick summary from tool call info (no LLM needed).
 * For simple cases, heuristic summarization is sufficient.
 */
export function summarizeStep(
  step: number,
  toolName: string,
  toolInput: Record<string, unknown>,
  ok: boolean,
): StepSummary {
  const tag = classifyActivity(toolName);
  let summary: string;

  // Generate summary based on tool and input
  switch (toolName) {
    case 'file_read':
      summary = `Read ${shortenPath(toolInput.path as string)}`;
      break;
    case 'file_write':
      summary = `Wrote ${shortenPath(toolInput.path as string)}`;
      break;
    case 'file_edit':
      summary = `Edited ${shortenPath(toolInput.path as string)}`;
      break;
    case 'shell':
      summary = `Ran: ${truncate(toolInput.command as string, 50)}`;
      break;
    case 'glob':
      summary = `Searched for ${toolInput.pattern as string}`;
      break;
    case 'grep':
      summary = `Grep: ${truncate(toolInput.pattern as string, 40)}`;
      break;
    case 'git_commit':
      summary = `Committed: ${truncate(toolInput.message as string, 50)}`;
      break;
    case 'git_status':
      summary = 'Checked git status';
      break;
    case 'git_diff':
      summary = 'Viewed diff';
      break;
    case 'multi_edit':
      summary = `Multi-edit ${shortenPath(toolInput.path as string)}`;
      break;
    case 'task_create':
      summary = `Created task: ${truncate(toolInput.description as string, 50)}`;
      break;
    default:
      summary = `${toolName}${ok ? '' : ' (failed)'}`;
  }

  if (!ok) summary += ' [FAILED]';

  return {
    summary: truncate(summary, 80),
    tag,
    step,
    timestamp: Date.now(),
  };
}

/**
 * Format step summaries as a timeline for display.
 */
export function formatStepTimeline(summaries: StepSummary[]): string {
  return summaries
    .map((s) => `  ${s.step}. [${s.tag}] ${s.summary}`)
    .join('\n');
}

function shortenPath(path: string | undefined): string {
  if (!path) return '(unknown)';
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-2).join('/')}`;
}

function truncate(str: string | undefined, maxLen: number): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
