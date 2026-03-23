import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import TOML from '@iarna/toml';
import { brainstormConfigSchema, type BrainstormConfig } from './schema.js';

const GLOBAL_CONFIG_DIR = join(homedir(), '.brainstorm');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.toml');
const PROJECT_CONFIG_FILE = 'brainstorm.toml';
const PROJECT_CONTEXT_FILE = 'BRAINSTORM.md';

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  return TOML.parse(content) as Record<string, unknown>;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
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

export function loadConfig(projectDir: string = process.cwd()): BrainstormConfig {
  // Layer 1: Global config
  const global = readToml(GLOBAL_CONFIG_FILE);
  // Layer 2: Project config
  const project = readToml(join(projectDir, PROJECT_CONFIG_FILE));
  // Merge: project overrides global
  let merged = deepMerge(global, project);
  // Layer 3: Environment variables
  merged = applyEnvOverrides(merged);
  // Validate and apply defaults
  return brainstormConfigSchema.parse(merged);
}

export function loadProjectContext(projectDir: string = process.cwd()): string | null {
  const contextPath = join(projectDir, PROJECT_CONTEXT_FILE);
  if (!existsSync(contextPath)) return null;
  return readFileSync(contextPath, 'utf-8');
}

export { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE };
