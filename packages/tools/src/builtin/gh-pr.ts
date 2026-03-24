import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

/**
 * GitHub PR tool — create, list, and view pull requests via the gh CLI.
 * Requires `gh` to be installed and authenticated.
 */
export const ghPrTool = defineTool({
  name: 'gh_pr',
  description:
    'Create, list, or view GitHub pull requests via the gh CLI. For "create": gathers branch context (commits, diff) and creates a PR with title + body. For "list": shows open PRs. For "view": shows PR details.',
  permission: 'confirm',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'view']).describe('PR action to perform'),
    // create fields
    title: z.string().optional().describe('PR title (< 70 chars). Required for "create".'),
    body: z.string().optional().describe('PR body (markdown). Required for "create".'),
    base: z.string().optional().describe('Base branch (default: main)'),
    draft: z.boolean().optional().describe('Create as draft PR'),
    // view fields
    number: z.number().optional().describe('PR number for "view" action'),
    // list fields
    state: z.enum(['open', 'closed', 'merged', 'all']).optional().describe('Filter PRs by state (default: open)'),
    limit: z.number().optional().describe('Max PRs to list (default: 10)'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ action, title, body, base, draft, number, state, limit, cwd }) {
    const opts = { cwd: cwd ?? process.cwd() };

    try {
      switch (action) {
        case 'create':
          return await createPr({ title, body, base, draft, opts });
        case 'list':
          return await listPrs({ state, limit, opts });
        case 'view':
          return await viewPr({ number, opts });
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});

async function createPr({
  title,
  body,
  base,
  draft,
  opts,
}: {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  opts: { cwd: string };
}) {
  if (!title) return { error: 'title is required for "create" action' };
  if (!body) return { error: 'body is required for "create" action' };

  const args = ['pr', 'create', '--title', title, '--body', body];
  if (base) args.push('--base', base);
  if (draft) args.push('--draft');

  const { stdout } = await execFileAsync('gh', args, opts);
  return { success: true, url: stdout.trim() };
}

async function listPrs({
  state,
  limit,
  opts,
}: {
  state?: string;
  limit?: number;
  opts: { cwd: string };
}) {
  const args = ['pr', 'list', '--json', 'number,title,state,author,url', '--limit', String(limit ?? 10)];
  if (state && state !== 'all') args.push('--state', state);

  const { stdout } = await execFileAsync('gh', args, opts);
  return { prs: JSON.parse(stdout) };
}

async function viewPr({ number, opts }: { number?: number; opts: { cwd: string } }) {
  if (!number) return { error: 'number is required for "view" action' };

  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'view', String(number), '--json', 'number,title,state,body,author,url,additions,deletions,files'],
    opts,
  );
  return { pr: JSON.parse(stdout) };
}
