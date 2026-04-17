import { readFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import TOML from "@iarna/toml";
import { createLogger } from "@brainst0rm/shared";
import { brainstormConfigSchema, type BrainstormConfig } from "./schema.js";

const log = createLogger("config");

const GLOBAL_CONFIG_DIR = join(homedir(), ".brainstorm");
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, "config.toml");
const PROJECT_CONFIG_FILE = "brainstorm.toml";
function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  return TOML.parse(content) as Record<string, unknown>;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function applyEnvOverrides(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };
  // BRAINSTORM_DEFAULT_STRATEGY overrides general.defaultStrategy
  if (process.env.BRAINSTORM_DEFAULT_STRATEGY) {
    const general = (result.general ?? {}) as Record<string, unknown>;
    general.defaultStrategy = process.env.BRAINSTORM_DEFAULT_STRATEGY;
    result.general = general;
  }
  // BRAINSTORM_BUDGET_DAILY overrides budget.daily
  if (process.env.BRAINSTORM_BUDGET_DAILY) {
    const budget = (result.budget ?? {}) as Record<string, unknown>;
    budget.daily = parseFloat(process.env.BRAINSTORM_BUDGET_DAILY);
    result.budget = budget;
  }
  return result;
}

function readJsonSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    log.warn({ err: e, path }, "Failed to parse JSON config file");
    return {};
  }
}

/**
 * Load MCP server configs from .brainstorm/mcp.json files.
 * Project-level servers override global by name.
 */
function loadMCPServers(projectDir: string): Array<Record<string, unknown>> {
  const globalMcp = readJsonSafe(join(GLOBAL_CONFIG_DIR, "mcp.json"));
  const projectMcp = readJsonSafe(join(projectDir, ".brainstorm", "mcp.json"));

  const globalServers = Array.isArray(globalMcp.servers)
    ? globalMcp.servers
    : [];
  const projectServers = Array.isArray(projectMcp.servers)
    ? projectMcp.servers
    : [];

  // Project servers override global by name
  const byName = new Map<string, Record<string, unknown>>();
  for (const s of globalServers)
    byName.set((s as any).name, s as Record<string, unknown>);
  for (const s of projectServers)
    byName.set((s as any).name, s as Record<string, unknown>);
  return Array.from(byName.values());
}

export function loadConfig(
  projectDir: string = process.cwd(),
): BrainstormConfig {
  // Layer 1: Global config
  const global = readToml(GLOBAL_CONFIG_FILE);
  // Layer 2: Project config
  const project = readToml(join(projectDir, PROJECT_CONFIG_FILE));
  // Merge: project overrides global
  let merged = deepMerge(global, project);
  // Layer 3: Environment variables
  merged = applyEnvOverrides(merged);
  // Layer 4: MCP servers from mcp.json files
  const mcpServers = loadMCPServers(projectDir);
  if (mcpServers.length > 0) {
    const mcp = (merged.mcp ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(mcp.servers) ? mcp.servers : [];
    mcp.servers = [...existing, ...mcpServers];
    merged.mcp = mcp;
  }
  // Validate and apply defaults
  return brainstormConfigSchema.parse(merged);
}

export { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE };

/**
 * Watch config files for changes and invoke callback.
 * Watches both global (~/.brainstorm/config.toml) and project (brainstorm.toml).
 * Returns a cleanup function to stop watching.
 */
export function watchConfig(
  projectDir: string,
  onChange: (file: string) => void,
): () => void {
  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const notify = (file: string) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      log.info({ file }, "Config file changed");
      onChange(file);
    }, 500);
  };

  // Watch the *parent directory* and filter by basename. Watching the file
  // directly breaks on atomic saves (vim backup-on-write, VS Code default,
  // most macOS editors): the save replaces the inode and the old watcher
  // becomes inert with no event. A directory watcher survives because the
  // inode it holds — the parent — doesn't change.
  const watchParentOf = (filePath: string, label: string) => {
    const parent = dirname(filePath);
    const name = basename(filePath);
    if (!existsSync(parent)) return;
    try {
      const w = watch(parent, (_eventType, changed) => {
        if (!changed) return;
        if (changed === name) notify(filePath);
      });
      w.unref();
      watchers.push(w);
    } catch (e) {
      log.warn({ err: e, label }, "Failed to watch config directory");
    }
  };

  if (existsSync(GLOBAL_CONFIG_FILE)) {
    watchParentOf(GLOBAL_CONFIG_FILE, "global");
  }

  const projectFile = join(projectDir, PROJECT_CONFIG_FILE);
  if (existsSync(projectFile)) {
    watchParentOf(projectFile, "project");
  }

  return () => {
    if (debounce) clearTimeout(debounce);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  };
}
