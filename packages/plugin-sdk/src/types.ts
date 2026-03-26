import type { z } from 'zod';
import type { ToolPermission } from '@brainstorm/shared';

/**
 * Plugin tool definition — same shape as Brainstorm's built-in tools.
 */
export interface PluginToolDef<T extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: T;
  execute: (input: z.infer<T>) => Promise<unknown>;
}

/**
 * Plugin hook definition — lifecycle event handlers.
 */
export interface PluginHookDef {
  event: PluginHookEvent;
  /** Optional: only fire for specific tool names (regex pattern). */
  matcher?: string;
  /** Shell command to run. Use $FILE and $TOOL for variable expansion. */
  command: string;
  /** If true, a failing hook blocks the operation (PreToolUse only). */
  blocking?: boolean;
  /** Human-readable description. */
  description?: string;
}

export type PluginHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreCompact'
  | 'PreCommit'
  | 'SubagentStart'
  | 'SubagentStop';

/**
 * Plugin skill definition — reusable instruction bundles.
 */
export interface PluginSkillDef {
  name: string;
  description: string;
  /** System prompt override for this skill. */
  systemPrompt?: string;
  /** Restrict which tools this skill can use. */
  tools?: string[];
  /** Routing preference when this skill is active. */
  modelPreference?: 'cheap' | 'quality' | 'fast' | 'auto';
  /** Max agentic steps for this skill. */
  maxSteps?: number;
  /** Content/instructions for the skill (markdown). */
  content: string;
}

/**
 * Full plugin definition — the main export of a Brainstorm plugin.
 */
export interface BrainstormPlugin {
  /** Unique plugin name (lowercase, hyphens allowed). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Plugin version (semver). */
  version: string;
  /** Tools provided by this plugin. */
  tools?: PluginToolDef[];
  /** Lifecycle hooks provided by this plugin. */
  hooks?: PluginHookDef[];
  /** Skills (reusable instruction bundles) provided by this plugin. */
  skills?: PluginSkillDef[];
  /** Called when the plugin is loaded. Use for setup/validation. */
  onLoad?: () => Promise<void> | void;
  /** Called when the plugin is unloaded. Use for cleanup. */
  onUnload?: () => Promise<void> | void;
}

/**
 * Plugin manifest — metadata for plugin discovery.
 */
export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** Main entry point (default: ./dist/index.js). */
  main?: string;
  /** Minimum Brainstorm CLI version required. */
  brainstormVersion?: string;
}
