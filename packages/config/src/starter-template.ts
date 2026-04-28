/**
 * Starter-template types shared between `@brainst0rm/cli` (the consumer)
 * and `@brainst0rm/archetype-*` packages (the producers).
 *
 * A template is an opt-in shortcut over the progressive-bootstrap default
 * (Decision #2). It pre-populates the seven-folder skeleton with archetype-
 * appropriate stubs so `harness summary` shows a populated dashboard
 * immediately.
 */

export interface TemplateFile {
  /** Relative path inside the harness root. */
  path: string;
  /** File content (UTF-8). */
  content: string;
}

export interface StarterTemplate {
  /** Slug used in `--template <slug>`. */
  slug: string;
  /** Human-readable description for `--help`. */
  description: string;
  /** Archetype this template targets — written into business.toml. */
  archetype: string;
  /** Files to materialize relative to harness root. */
  files: TemplateFile[];
}
