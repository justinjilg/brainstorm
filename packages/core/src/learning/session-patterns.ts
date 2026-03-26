/**
 * Cross-Session Learning — records per-project patterns that improve over time.
 *
 * Patterns tracked:
 * - tool_success: which tools fail frequently (e.g., file_edit fails on JSX)
 * - command_timing: how long shell commands take (e.g., npm test takes 45s)
 * - user_preference: what users prefer (e.g., always rejects layout changes)
 * - model_choice: which models work best for this project
 *
 * Loaded on session start, updated during session, decayed over 30 days.
 */

import type { PatternRepository, SessionPattern } from '@brainstorm/db';

export class SessionPatternLearner {
  constructor(
    private repo: PatternRepository,
    private projectPath: string,
  ) {}

  /** Record a tool success/failure pattern. */
  recordToolResult(toolName: string, success: boolean): void {
    this.repo.record(
      this.projectPath,
      'tool_success',
      toolName,
      success ? 'reliable' : 'unreliable',
      success ? 0.6 : 0.4,
    );
  }

  /** Record a shell command timing. */
  recordCommandTiming(command: string, durationMs: number): void {
    // Normalize command to a key (first 2 words)
    const key = command.split(/\s+/).slice(0, 3).join(' ').slice(0, 50);
    const category = durationMs > 30000 ? 'slow' : durationMs > 5000 ? 'moderate' : 'fast';
    this.repo.record(
      this.projectPath,
      'command_timing',
      key,
      `${category} (~${Math.round(durationMs / 1000)}s)`,
    );
  }

  /** Record a user preference signal. */
  recordUserPreference(key: string, value: string): void {
    this.repo.record(this.projectPath, 'user_preference', key, value);
  }

  /** Record which model was successful for a task type. */
  recordModelChoice(taskType: string, modelId: string): void {
    this.repo.record(this.projectPath, 'model_choice', taskType, modelId);
  }

  /** Get all patterns for the current project. */
  getPatterns(): SessionPattern[] {
    return this.repo.getForProject(this.projectPath);
  }

  /** Format patterns for system prompt injection. */
  formatForPrompt(): string {
    return this.repo.formatForPrompt(this.projectPath);
  }

  /** Run decay on old patterns. Called periodically (e.g., on session start). */
  decay(): number {
    return this.repo.decayOld(30);
  }
}
