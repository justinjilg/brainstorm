/**
 * Community Knowledge Graph — crowdsourced debugging intelligence.
 *
 * When Brainstorm fixes a build error (error → fix pair), the fix can be
 * anonymized and shared via BrainstormRouter. Other users hitting the same
 * error get the fix suggested automatically.
 *
 * Client-side implementation. Requires BR API endpoints:
 *   POST /v1/community/fixes  — submit anonymized fix pair
 *   GET  /v1/community/fixes  — query known fixes by error signature
 *
 * Opt-in via config: [community] share_fixes = true
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeErrorSignature, type ErrorFixPair } from './error-fix-pairs.js';

export interface CommunityFixPair {
  /** Normalized error signature (no paths, no line numbers). */
  errorSignature: string;
  /** Detected framework from package.json (e.g., "next", "react"). */
  framework: string;
  /** Relevant dependency and version (e.g., "drizzle-orm@0.45"). */
  dependency?: string;
  /** Human-readable fix description. */
  fixDescription: string;
  /** Anonymized diff (stripped of project-specific paths). */
  fixDiff?: string;
  /** Confidence that this fix is correct (0-1). */
  confidence: number;
  /** Whether the build passed after applying this fix. */
  verified: boolean;
}

export interface CommunityFixResult {
  /** Error signature that was queried. */
  errorSignature: string;
  /** Known fixes from the community. */
  fixes: Array<CommunityFixPair & {
    /** Number of users who confirmed this fix worked. */
    confirmations: number;
    /** When this fix was first submitted. */
    firstSeen: string;
  }>;
}

/**
 * Submit an anonymized fix pair to BrainstormRouter's community knowledge graph.
 *
 * @param baseUrl - BrainstormRouter API base URL
 * @param apiKey - API key for authentication
 * @param fixPair - The error-fix pair to submit
 * @param framework - Detected framework (from package.json)
 */
export async function submitCommunityFix(
  baseUrl: string,
  apiKey: string,
  fixPair: ErrorFixPair,
  framework: string,
): Promise<boolean> {
  try {
    const communityFix: CommunityFixPair = {
      errorSignature: fixPair.errorSignature,
      framework,
      fixDescription: fixPair.fixDescription,
      confidence: 0.8,
      verified: true,
    };

    const response = await fetch(`${baseUrl}/v1/community/fixes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(communityFix),
    });

    return response.ok;
  } catch {
    // Community sharing is best-effort — never fail the user's workflow
    return false;
  }
}

/**
 * Query known community fixes for a given error.
 *
 * @param baseUrl - BrainstormRouter API base URL
 * @param apiKey - API key for authentication
 * @param errorMessage - The raw error message to look up
 */
export async function queryCommunityFixes(
  baseUrl: string,
  apiKey: string,
  errorMessage: string,
): Promise<CommunityFixResult | null> {
  try {
    const signature = normalizeErrorSignature(errorMessage);
    const response = await fetch(
      `${baseUrl}/v1/community/fixes?error=${encodeURIComponent(signature)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );

    if (!response.ok) return null;

    return (await response.json()) as CommunityFixResult;
  } catch {
    return null;
  }
}

/**
 * Format community fixes for injection into the agent context.
 */
export function formatCommunityFixes(result: CommunityFixResult): string {
  if (!result.fixes.length) return '';

  const top = result.fixes
    .filter((f) => f.confirmations >= 3)
    .slice(0, 3);

  if (top.length === 0) return '';

  const lines = ['Known community fixes for this error:'];
  for (const fix of top) {
    lines.push(
      `  - ${fix.fixDescription} (verified by ${fix.confirmations} users, ${fix.framework})`,
    );
  }

  return lines.join('\n');
}

/**
 * Detect the project framework from package.json.
 */
export function detectFramework(projectPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    if (deps.next) return 'next';
    if (deps.react) return 'react';
    if (deps.vue) return 'vue';
    if (deps.svelte) return 'svelte';
    if (deps.angular) return 'angular';
    if (deps.express) return 'express';
    if (deps.fastify) return 'fastify';
    if (deps.hono) return 'hono';

    return 'unknown';
  } catch {
    return 'unknown';
  }
}
