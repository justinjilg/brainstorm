/**
 * Build State Tracker — persists last build/test result across turns.
 * When a shell command matches the project's build_command or test_command,
 * the result is captured. If the build is broken, a persistent warning
 * is injected into the system context until it passes again.
 */

export interface BuildResult {
  command: string;
  exitCode: number;
  errorSummary: string;
  timestamp: number;
}

export type BuildStatus = 'passing' | 'failing' | 'unknown';

export class BuildStateTracker {
  private lastBuild: BuildResult | null = null;
  private lastTest: BuildResult | null = null;
  private buildPatterns: RegExp[] = [];
  private testPatterns: RegExp[] = [];

  constructor(buildCommand?: string, testCommand?: string) {
    // Build default patterns + user-configured commands
    this.buildPatterns = [
      /\b(npm|pnpm|yarn|npx|turbo)\s+(run\s+)?build\b/,
      /\btsc\b/,
      /\bmake\b/,
    ];
    this.testPatterns = [
      /\b(npm|pnpm|yarn|npx|turbo)\s+(run\s+)?test\b/,
      /\bvitest\b/,
      /\bjest\b/,
      /\bpytest\b/,
    ];

    if (buildCommand) {
      this.buildPatterns.unshift(new RegExp(escapeRegex(buildCommand)));
    }
    if (testCommand) {
      this.testPatterns.unshift(new RegExp(escapeRegex(testCommand)));
    }
  }

  /** Check if a shell command is a build or test command and record the result. */
  recordShellResult(command: string, exitCode: number, stderr: string): void {
    const isBuild = this.buildPatterns.some((p) => p.test(command));
    const isTest = this.testPatterns.some((p) => p.test(command));

    if (isBuild) {
      this.lastBuild = {
        command,
        exitCode,
        errorSummary: exitCode !== 0 ? extractErrorSummary(stderr) : '',
        timestamp: Date.now(),
      };
    }

    if (isTest) {
      this.lastTest = {
        command,
        exitCode,
        errorSummary: exitCode !== 0 ? extractErrorSummary(stderr) : '',
        timestamp: Date.now(),
      };
    }
  }

  getStatus(): BuildStatus {
    if (!this.lastBuild && !this.lastTest) return 'unknown';
    if (this.lastBuild?.exitCode !== 0 && this.lastBuild) return 'failing';
    if (this.lastTest?.exitCode !== 0 && this.lastTest) return 'failing';
    return 'passing';
  }

  getLastBuild(): BuildResult | null {
    return this.lastBuild;
  }

  getLastTest(): BuildResult | null {
    return this.lastTest;
  }

  /** Format a persistent warning if the build is broken. Empty string if passing. */
  formatBuildWarning(): string {
    const warnings: string[] = [];

    if (this.lastBuild && this.lastBuild.exitCode !== 0) {
      warnings.push(`BUILD BROKEN: ${this.lastBuild.errorSummary || 'non-zero exit'}`);
    }
    if (this.lastTest && this.lastTest.exitCode !== 0) {
      warnings.push(`TESTS FAILING: ${this.lastTest.errorSummary || 'non-zero exit'}`);
    }

    if (warnings.length === 0) return '';
    return `[WARNING — ${warnings.join(' | ')}. Fix before creating new features.]`;
  }

  clear(): void {
    this.lastBuild = null;
    this.lastTest = null;
  }
}

/** Extract the most useful error lines from stderr (last 3 non-empty lines, max 200 chars). */
function extractErrorSummary(stderr: string): string {
  if (!stderr) return '';
  const lines = stderr.split('\n').filter((l) => l.trim().length > 0);
  const summary = lines.slice(-3).join(' | ');
  return summary.length > 200 ? summary.slice(-200) : summary;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
