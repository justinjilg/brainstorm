import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Probe, CapabilityDimension } from './types.js';

/**
 * Load all probes from the probes/ directory.
 * Each .json file contains an array of Probe objects.
 */
export function loadProbes(probesDir?: string): Probe[] {
  const dir = probesDir ?? findProbesDir();
  if (!dir || !existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const probes: Probe[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        probes.push(...parsed);
      }
    } catch { /* skip invalid probe files */ }
  }

  return probes;
}

/**
 * Load probes filtered by capability dimension.
 */
export function loadProbesByCapability(capability: CapabilityDimension, probesDir?: string): Probe[] {
  return loadProbes(probesDir).filter((p) => p.capability === capability);
}

/**
 * Find the probes directory relative to the eval package.
 * Works both in source (src/) and built (dist/) contexts.
 */
function findProbesDir(): string | null {
  // Try relative to this file (works in development)
  const candidates = [
    join(import.meta.dirname ?? '', '..', 'probes'),
    join(import.meta.dirname ?? '', '..', '..', 'probes'),
    join(process.cwd(), 'packages', 'eval', 'probes'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
