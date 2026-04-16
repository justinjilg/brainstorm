import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { BrainstormPlugin, PluginManifest } from "./types.js";

/**
 * Discover and load installed plugins.
 *
 * Plugins are discovered from:
 * 1. ~/.brainstorm/plugins/ — user-installed plugins
 * 2. .brainstorm/plugins/ — project-local plugins
 */
export async function discoverPlugins(
  projectPath: string,
): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];

  // 1. Global plugins
  const globalDir = join(homedir(), ".brainstorm", "plugins");
  plugins.push(...(await loadPluginsFromDir(globalDir, "global")));

  // 2. Project plugins
  const projectDir = join(projectPath, ".brainstorm", "plugins");
  plugins.push(...(await loadPluginsFromDir(projectDir, "project")));

  return plugins;
}

export interface LoadedPlugin {
  plugin: BrainstormPlugin;
  source: "global" | "project";
  path: string;
}

async function loadPluginsFromDir(
  dir: string,
  source: "global" | "project",
): Promise<LoadedPlugin[]> {
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
  const manifestPath = join(pluginDir, "package.json");
  if (!existsSync(manifestPath)) return null;

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Plugin manifest is not valid JSON: ${err.message}`);
  }

  const entryPoint = manifest.main ?? "./dist/index.js";
  // Resolve entryPath and verify it stays within pluginDir. A manifest with
  // "main": "../../../etc/passwd" or an absolute path would otherwise let
  // an untrusted plugin load arbitrary JS files from the host filesystem.
  const pluginRoot = realpathSync(resolve(pluginDir));
  let entryPath: string;
  try {
    entryPath = realpathSync(resolve(pluginRoot, entryPoint));
  } catch {
    entryPath = resolve(pluginRoot, entryPoint);
  }
  if (entryPath !== pluginRoot && !entryPath.startsWith(pluginRoot + sep)) {
    throw new Error(
      `Plugin entry point escapes plugin directory: ${entryPoint}`,
    );
  }

  if (!existsSync(entryPath)) {
    throw new Error(`Plugin entry point not found: ${entryPath}`);
  }

  // Dynamic import the plugin
  const entryUrl = pathToFileURL(entryPath).href;
  const mod = await import(entryUrl);
  const plugin: BrainstormPlugin = mod.default ?? mod;

  // Validate required fields
  if (!plugin.name || !plugin.version) {
    throw new Error(
      `Plugin at ${pluginDir} is missing required fields (name, version).`,
    );
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
  return join(homedir(), ".brainstorm", "plugins");
}

/**
 * Get the project plugins directory path.
 */
export function getProjectPluginsDir(projectPath: string): string {
  return join(projectPath, ".brainstorm", "plugins");
}
