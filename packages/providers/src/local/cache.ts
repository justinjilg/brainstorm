import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelEntry } from '@brainstorm/shared';

const CACHE_DIR = join(homedir(), '.brainstorm', 'cache');
const CACHE_FILE = join(CACHE_DIR, 'models.json');
const CACHE_TTL_MS = 60_000; // 60 seconds

interface CachedDiscovery {
  models: ModelEntry[];
  timestamp: number;
}

/**
 * Read cached model discovery results.
 * Returns null if cache is expired or doesn't exist.
 */
export function readDiscoveryCache(): ModelEntry[] | null {
  if (!existsSync(CACHE_FILE)) return null;

  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as CachedDiscovery;
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data.models;
  } catch {
    return null;
  }
}

/**
 * Write model discovery results to cache.
 */
export function writeDiscoveryCache(models: ModelEntry[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const data: CachedDiscovery = { models, timestamp: Date.now() };
  writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');
}

/**
 * Invalidate the discovery cache (e.g., on `storm models --refresh`).
 */
export function invalidateDiscoveryCache(): void {
  if (existsSync(CACHE_FILE)) {
    writeFileSync(CACHE_FILE, '', 'utf-8');
  }
}
