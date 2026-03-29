import { z } from "zod";
import type { ToolPermission } from "@brainst0rm/shared";
import type {
  BrainstormPlugin,
  PluginToolDef,
  PluginHookDef,
  PluginSkillDef,
} from "./types.js";

/**
 * Define a Brainstorm plugin.
 *
 * @example
 * ```typescript
 * import { defineBrainstormPlugin, definePluginTool } from '@brainst0rm/plugin-sdk';
 * import { z } from 'zod';
 *
 * export default defineBrainstormPlugin({
 *   name: 'docker',
 *   description: 'Docker integration for Brainstorm',
 *   version: '0.1.0',
 *   tools: [
 *     definePluginTool({
 *       name: 'docker_build',
 *       description: 'Build a Docker image',
 *       permission: 'confirm',
 *       inputSchema: z.object({
 *         tag: z.string().describe('Image tag'),
 *         dockerfile: z.string().optional().describe('Path to Dockerfile'),
 *       }),
 *       async execute({ tag, dockerfile }) {
 *         // Implementation...
 *         return { ok: true, data: { tag } };
 *       },
 *     }),
 *   ],
 *   hooks: [
 *     {
 *       event: 'SessionStart',
 *       command: 'docker info > /dev/null 2>&1 || echo "Docker daemon not running"',
 *       description: 'Check Docker daemon on session start',
 *     },
 *   ],
 * });
 * ```
 */
export function defineBrainstormPlugin(
  config: BrainstormPlugin,
): BrainstormPlugin {
  validatePlugin(config);
  return config;
}

/**
 * Define a plugin tool with type-safe input schema.
 */
export function definePluginTool<T extends z.ZodObject<any>>(config: {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: T;
  execute: (input: z.infer<T>) => Promise<unknown>;
}): PluginToolDef<T> {
  return config;
}

/**
 * Define a plugin hook.
 */
export function definePluginHook(config: PluginHookDef): PluginHookDef {
  return config;
}

/**
 * Define a plugin skill.
 */
export function definePluginSkill(config: PluginSkillDef): PluginSkillDef {
  return config;
}

/**
 * Validate a plugin definition for common errors.
 */
function validatePlugin(plugin: BrainstormPlugin): void {
  if (!plugin.name || !/^[a-z][a-z0-9-]*$/.test(plugin.name)) {
    throw new Error(
      `Plugin name "${plugin.name}" is invalid. Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens.`,
    );
  }

  if (!plugin.description) {
    throw new Error(`Plugin "${plugin.name}" is missing a description.`);
  }

  if (!plugin.version || !/^\d+\.\d+\.\d+/.test(plugin.version)) {
    throw new Error(
      `Plugin "${plugin.name}" has invalid version "${plugin.version}". Use semver (e.g., 1.0.0).`,
    );
  }

  // Validate tool names are unique
  if (plugin.tools) {
    const names = new Set<string>();
    for (const tool of plugin.tools) {
      if (names.has(tool.name)) {
        throw new Error(
          `Plugin "${plugin.name}" has duplicate tool name "${tool.name}".`,
        );
      }
      names.add(tool.name);
    }
  }

  // Validate skill names are unique
  if (plugin.skills) {
    const names = new Set<string>();
    for (const skill of plugin.skills) {
      if (names.has(skill.name)) {
        throw new Error(
          `Plugin "${plugin.name}" has duplicate skill name "${skill.name}".`,
        );
      }
      names.add(skill.name);
    }
  }
}
