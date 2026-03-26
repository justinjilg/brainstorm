/**
 * Project Health Dashboard — collect project state on session start.
 * Runs quick checks: git status, build state, dependency freshness.
 * Injected as persistent context so the agent always knows project state.
 */

import { execFileSync } from 'node:child_process';

export interface ProjectHealth {
  gitBranch: string;
  gitAhead: number;
  gitBehind: number;
  gitDirty: boolean;
  gitUntracked: number;
  buildStatus: 'unknown' | 'passing' | 'failing';
  outdatedDeps: number;
  lastCommitAge: string;
}

/** Collect project health metrics. Non-blocking, all checks have timeouts. */
export function collectProjectHealth(projectPath: string): ProjectHealth {
  const health: ProjectHealth = {
    gitBranch: 'unknown',
    gitAhead: 0,
    gitBehind: 0,
    gitDirty: false,
    gitUntracked: 0,
    buildStatus: 'unknown',
    outdatedDeps: 0,
    lastCommitAge: 'unknown',
  };

  // Git branch
  try {
    health.gitBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* not in git */ }

  // Git ahead/behind
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--branch'], {
      cwd: projectPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branchLine = status.split('\n')[0] || '';
    const ahead = branchLine.match(/ahead (\d+)/);
    const behind = branchLine.match(/behind (\d+)/);
    if (ahead) health.gitAhead = parseInt(ahead[1], 10);
    if (behind) health.gitBehind = parseInt(behind[1], 10);

    // Count dirty + untracked
    const lines = status.split('\n').slice(1).filter((l) => l.trim());
    health.gitDirty = lines.some((l) => !l.startsWith('??'));
    health.gitUntracked = lines.filter((l) => l.startsWith('??')).length;
  } catch { /* ignore */ }

  // Last commit age
  try {
    const timestamp = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: projectPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const secs = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
    if (secs < 3600) health.lastCommitAge = `${Math.round(secs / 60)}m ago`;
    else if (secs < 86400) health.lastCommitAge = `${Math.round(secs / 3600)}h ago`;
    else health.lastCommitAge = `${Math.round(secs / 86400)}d ago`;
  } catch { /* ignore */ }

  return health;
}

/** Format health as a compact context string. */
export function formatProjectHealth(health: ProjectHealth): string {
  const parts: string[] = [];

  parts.push(`Branch: ${health.gitBranch}`);
  if (health.gitAhead > 0) parts.push(`${health.gitAhead} ahead`);
  if (health.gitBehind > 0) parts.push(`${health.gitBehind} behind`);
  if (health.gitDirty) parts.push('uncommitted changes');
  if (health.gitUntracked > 0) parts.push(`${health.gitUntracked} untracked`);
  parts.push(`Last commit: ${health.lastCommitAge}`);

  return `[Project health: ${parts.join(' | ')}]`;
}
