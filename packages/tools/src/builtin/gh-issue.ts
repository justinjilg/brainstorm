import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

/**
 * GitHub Issue tool — create, list, and view issues via the gh CLI.
 * Requires `gh` to be installed and authenticated.
 */
export const ghIssueTool = defineTool({
  name: 'gh_issue',
  description:
    'Create, list, or view GitHub issues via the gh CLI. For "create": opens a new issue with title + body. For "list": shows open issues. For "view": shows issue details and comments.',
  permission: 'confirm',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'view']).describe('Issue action to perform'),
    // create fields
    title: z.string().optional().describe('Issue title. Required for "create".'),
    body: z.string().optional().describe('Issue body (markdown). Required for "create".'),
    labels: z.array(z.string()).optional().describe('Labels to apply (for "create")'),
    assignees: z.array(z.string()).optional().describe('GitHub usernames to assign (for "create")'),
    // view fields
    number: z.number().optional().describe('Issue number for "view" action'),
    // list fields
    state: z.enum(['open', 'closed', 'all']).optional().describe('Filter issues by state (default: open)'),
    label: z.string().optional().describe('Filter by label (for "list")'),
    limit: z.number().optional().describe('Max issues to list (default: 10)'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ action, title, body, labels, assignees, number, state, label, limit, cwd }) {
    const opts = { cwd: cwd ?? process.cwd() };

    try {
      switch (action) {
        case 'create':
          return await createIssue({ title, body, labels, assignees, opts });
        case 'list':
          return await listIssues({ state, label, limit, opts });
        case 'view':
          return await viewIssue({ number, opts });
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});

async function createIssue({
  title,
  body,
  labels,
  assignees,
  opts,
}: {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  opts: { cwd: string };
}) {
  if (!title) return { error: 'title is required for "create" action' };

  const args = ['issue', 'create', '--title', title];
  if (body) args.push('--body', body);
  if (labels && labels.length > 0) args.push('--label', labels.join(','));
  if (assignees && assignees.length > 0) args.push('--assignee', assignees.join(','));

  const { stdout } = await execFileAsync('gh', args, opts);
  return { success: true, url: stdout.trim() };
}

async function listIssues({
  state,
  label,
  limit,
  opts,
}: {
  state?: string;
  label?: string;
  limit?: number;
  opts: { cwd: string };
}) {
  const args = ['issue', 'list', '--json', 'number,title,state,author,labels,url', '--limit', String(limit ?? 10)];
  if (state && state !== 'all') args.push('--state', state);
  if (label) args.push('--label', label);

  const { stdout } = await execFileAsync('gh', args, opts);
  return { issues: JSON.parse(stdout) };
}

async function viewIssue({ number, opts }: { number?: number; opts: { cwd: string } }) {
  if (!number) return { error: 'number is required for "view" action' };

  const { stdout } = await execFileAsync(
    'gh',
    ['issue', 'view', String(number), '--json', 'number,title,state,body,author,labels,url,comments'],
    opts,
  );
  return { issue: JSON.parse(stdout) };
}
