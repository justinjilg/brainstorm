/**
 * Git safety layer — guards against destructive git operations.
 *
 * Rules:
 * 1. Never force-push to main/master
 * 2. Never skip hooks (--no-verify, --no-gpg-sign)
 * 3. Prefer new commits over --amend
 * 4. Never use `git add -A` or `git add .` — stage specific files
 * 5. Scan staged files for credentials before commit
 * 6. Require confirmation for destructive ops (reset --hard, checkout --, clean -f)
 */

export interface GitSafetyViolation {
  rule: string;
  description: string;
  suggestion: string;
}

const PROTECTED_BRANCHES = ['main', 'master', 'production', 'release'];

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; rule: string; description: string; suggestion: string }> = [
  {
    pattern: /git\s+push\s+.*--force(?:-with-lease)?\b/,
    rule: 'no-force-push-main',
    description: 'Force-pushing can overwrite upstream commits and cause data loss.',
    suggestion: 'Use `git push` without --force flag. If you need to update a remote branch, use `git push --force-with-lease` on a feature branch (never main/master).',
  },
  {
    pattern: /git\s+reset\s+--hard\b/,
    rule: 'no-hard-reset',
    description: 'git reset --hard discards all uncommitted changes permanently.',
    suggestion: 'Use `git stash` to save changes before resetting, or use `git reset --soft` to keep changes staged.',
  },
  {
    pattern: /git\s+checkout\s+--\s/,
    rule: 'no-checkout-discard',
    description: 'git checkout -- discards uncommitted changes to files permanently.',
    suggestion: 'Use `git stash` to save changes first, or verify you truly want to discard.',
  },
  {
    pattern: /git\s+clean\s+-[a-zA-Z]*f/,
    rule: 'no-clean-force',
    description: 'git clean -f permanently deletes untracked files.',
    suggestion: 'Use `git clean -n` (dry run) first to see what would be deleted.',
  },
  {
    pattern: /git\s+branch\s+-[a-zA-Z]*D\b/,
    rule: 'no-force-delete-branch',
    description: 'git branch -D force-deletes a branch even if not fully merged.',
    suggestion: 'Use `git branch -d` (lowercase) which only deletes if fully merged.',
  },
  {
    pattern: /git\s+rebase\s+-i\b/,
    rule: 'no-interactive-rebase',
    description: 'Interactive rebase requires terminal interaction which is not supported.',
    suggestion: 'Use non-interactive rebase or create new commits instead.',
  },
];

const HOOK_SKIP_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  { pattern: /--no-verify\b/, flag: '--no-verify' },
  { pattern: /--no-gpg-sign\b/, flag: '--no-gpg-sign' },
  { pattern: /-c\s+commit\.gpgsign=false\b/, flag: 'commit.gpgsign=false' },
  { pattern: /-c\s+core\.hooksPath=/, flag: 'core.hooksPath override' },
  { pattern: /\bHUSKY=0\b/, flag: 'HUSKY=0' },
];

const BROAD_STAGING_PATTERNS = [
  /git\s+add\s+-A\b/,
  /git\s+add\s+--all\b/,
  /git\s+add\s+\.\s*$/,
];

/**
 * Check if a command targets a protected branch with force-push.
 */
function isForceToProtected(command: string): boolean {
  const forcePush = /git\s+push\s+.*--force(?:-with-lease)?\b/.test(command);
  if (!forcePush) return false;

  // Check if any protected branch name appears in the command
  for (const branch of PROTECTED_BRANCHES) {
    if (new RegExp(`\\b${branch}\\b`).test(command)) return true;
  }
  // `git push --force origin` without a branch targets the current tracking branch
  // which could be main — flag it as suspicious
  if (/git\s+push\s+--force\s+\w+\s*$/.test(command)) return true;
  return false;
}

/**
 * Check a shell command for git safety violations.
 * Returns violations found, or empty array if safe.
 */
export function checkGitSafety(command: string): GitSafetyViolation[] {
  const violations: GitSafetyViolation[] = [];

  // Check force-push to protected branches (highest severity)
  if (isForceToProtected(command)) {
    violations.push({
      rule: 'no-force-push-protected',
      description: `Force-pushing to a protected branch (${PROTECTED_BRANCHES.join('/')}) can destroy team members' work.`,
      suggestion: 'Never force-push to main/master. Create a new branch and PR instead.',
    });
  }

  // Check destructive operations
  for (const { pattern, rule, description, suggestion } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      // Skip force-push if already caught as protected branch
      if (rule === 'no-force-push-main' && violations.some((v) => v.rule === 'no-force-push-protected')) continue;
      violations.push({ rule, description, suggestion });
    }
  }

  // Check hook-skipping flags
  for (const { pattern, flag } of HOOK_SKIP_PATTERNS) {
    if (pattern.test(command)) {
      violations.push({
        rule: 'no-skip-hooks',
        description: `The flag ${flag} bypasses git hooks. Pre-commit hooks exist for a reason (linting, tests, secrets detection).`,
        suggestion: `Remove ${flag} and fix the underlying issue that the hook is catching.`,
      });
    }
  }

  // Check --amend
  if (/git\s+commit\s+.*--amend\b/.test(command)) {
    violations.push({
      rule: 'prefer-new-commit',
      description: 'Amending rewrites the previous commit. If the previous commit was already pushed, this causes divergence.',
      suggestion: 'Create a new commit instead. If you must amend, only do so on unpushed commits.',
    });
  }

  // Check broad staging
  for (const pattern of BROAD_STAGING_PATTERNS) {
    if (pattern.test(command)) {
      violations.push({
        rule: 'no-broad-staging',
        description: '`git add -A` or `git add .` can accidentally stage secrets (.env), large files, or unrelated changes.',
        suggestion: 'Stage specific files by name: `git add path/to/file.ts path/to/other.ts`',
      });
      break;
    }
  }

  return violations;
}

/**
 * Format violations as a human-readable block message.
 */
export function formatViolations(violations: GitSafetyViolation[]): string {
  if (violations.length === 0) return '';

  const lines = ['Git safety: blocked operation\n'];
  for (const v of violations) {
    lines.push(`  [${v.rule}] ${v.description}`);
    lines.push(`  → ${v.suggestion}\n`);
  }
  return lines.join('\n');
}

/**
 * Returns true if any violation is a hard block (must not proceed).
 * Some violations are warnings (--amend, broad staging) that the model can override with reasoning.
 */
export function hasHardBlock(violations: GitSafetyViolation[]): boolean {
  const HARD_RULES = new Set([
    'no-force-push-protected',
    'no-force-push-main',
    'no-skip-hooks',
    'no-hard-reset',
    'no-clean-force',
    'no-interactive-rebase',
  ]);
  return violations.some((v) => HARD_RULES.has(v.rule));
}
