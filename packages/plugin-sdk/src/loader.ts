import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { BrainstormPlugin, PluginManifest } from './types.js';

/**
 * Discover and load installed plugins.
 *
 * Plugins are discovered from:
 * 1. ~/.brainstorm/plugins/ — user-installed plugins
 * 2. .brainstorm/plugins/ — project-local plugins
 */
export async function discoverPlugins(projectPath: string): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];

  // 1. Global plugins
  const globalDir = join(homedir(), '.brainstorm', 'plugins');
  plugins.push(...(await loadPluginsFromDir(globalDir, 'global')));

  // 2. Project plugins
  const projectDir = join(projectPath, '.brainstorm', 'plugins');
  plugins.push(...(await loadPluginsFromDir(projectDir, 'project')));

  return plugins;
}

export interface LoadedPlugin {
  plugin: BrainstormPlugin;
  source: 'global' | 'project';
  path: string;
}

async function loadPluginsFromDir(dir: string, source: 'global' | 'project'): Promise<LoadedPlugin[]> {
  if (!existsSync(dir)) return [];

  const plugins: LoadedPlugin[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = join(dir, entry.name);
    try {
      const plugin = await loadPlugin(pluginDir);
      if (plugin) {
        plugins.push({ plugin, source, path: pluginDir });
      }
    } catch (err: any) {
      // Log but don't fail — bad plugins shouldn't crash the CLI
      console.error(`Failed to load plugin from ${pluginDir}: ${err.message}`);
    }
  }

  return plugins;
}

/**
 * Load a single plugin from a directory.
 *
 * Expects either:
 * - A package.json with a "main" field pointing to the entry
 * - A dist/index.js as default entry
 */
async function loadPlugin(pluginDir: string): Promise<BrainstormPlugin | null> {
  // Read manifest
  const manifestPath = join(pluginDir, 'package.json');
  if (!existsSync(manifestPath)) return null;

  const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const entryPoint = manifest.main ?? './dist/index.js';
  const entryPath = join(pluginDir, entryPoint);

  if (!existsSync(entryPath)) {
    throw new Error(`Plugin entry point not found: ${entryPath}`);
  }

  // Dynamic import the plugin
  const entryUrl = pathToFileURL(entryPath).href;
  const mod = await import(entryUrl);
  const plugin: BrainstormPlugin = mod.default ?? mod;

  // Validate required fields
  if (!plugin.name || !plugin.version) {
    throw new Error(`Plugin at ${pluginDir} is missing required fields (name, version).`);
  }

  // Run onLoad if present
  if (plugin.onLoad) {
    await plugin.onLoad();
  }

  return plugin;
}

/**
 * Get the global plugins directory path.
 */
export function getGlobalPluginsDir(): string {
  return join(homedir(), '.brainstorm', 'plugins');
}

/**
 * Get the project plugins directory path.
 */
export function getProjectPluginsDir(projectPath: string): string {
  return join(projectPath, '.brainstorm', 'plugins');
}
