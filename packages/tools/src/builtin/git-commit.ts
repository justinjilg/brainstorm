import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../base.js';

const execFileAsync = promisify(execFile);

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description: 'Stage specific files and create a git commit. You MUST provide explicit file paths — never stages all files. Scans staged content for credentials before committing.',
  permission: 'confirm',
  inputSchema: z.object({
    message: z.string().describe('Commit message (what + why)'),
    files: z.array(z.string()).min(1).describe('Files to stage — explicit paths required (no wildcards, no "all")'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  async execute({ message, files, cwd }) {
    const opts = { cwd: cwd ?? process.cwd() };
    try {
      // Stage specific files only (never git add -A)
      await execFileAsync('git', ['add', ...files], opts);

      // Scan staged diff for credentials before committing
      const { stdout: diff } = await execFileAsync('git', ['diff', '--cached', '--unified=0'], opts);
      const credentialHits = scanDiffForCredentials(diff);
      if (credentialHits.length > 0) {
        // Unstage and abort
        await execFileAsync('git', ['reset', 'HEAD', ...files], opts).catch(() => {});
        return {
          error: `Credential detected in staged changes — commit blocked.\n${credentialHits.map((h) => `  ${h.file}: ${h.pattern} (${h.preview})`).join('\n')}\n\nRemove the credential before committing.`,
        };
      }

      // Commit
      const { stdout } = await execFileAsync('git', ['commit', '-m', message], opts);
      return { success: true, output: stdout.trim() };
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});

interface CredentialHit {
  file: string;
  pattern: string;
  preview: string;
}

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: 'OpenAI/Anthropic Key', pattern: /sk-(?:ant-)?[A-Za-z0-9-]{20,}/ },
  { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'PEM Private Key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'BR API Key', pattern: /br_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'Generic Secret', pattern: /(?:password|token|api_key|apikey|secret)\s*[:=]\s*['"]([^'"]{8,})['"]/i },
];

function scanDiffForCredentials(diff: string): CredentialHit[] {
  const hits: CredentialHit[] = [];
  let currentFile = '';

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match?.[1] ?? '';
      continue;
    }
    // Only scan added lines (not removed)
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({
          file: currentFile,
          pattern: name,
          preview: line.slice(1, 60) + (line.length > 60 ? '...' : ''),
        });
      }
    }
  }
  return hits;
}
