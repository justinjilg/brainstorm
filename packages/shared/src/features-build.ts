/**
 * Build-time helper that generates tsup `define` maps for feature gating.
 *
 * Import this in tsup.config.ts files to control which features are
 * compiled into the bundle:
 *
 *   import { getFeatureDefines } from '@brainst0rm/shared/features-build';
 *
 *   export default defineConfig({
 *     // ...
 *     define: getFeatureDefines('oss'),
 *   });
 */

import type { FeatureName } from "./features.js";

/** Features enabled in each build target. */
const PROFILES: Record<"oss" | "saas" | "dev", Record<FeatureName, boolean>> = {
  /** Open-source build — SaaS features stripped. */
  oss: {
    GATEWAY_INTELLIGENCE: false,
    TRAJECTORY_CAPTURE: false,
    SAAS_ANALYTICS: false,
    CLOUD_MEMORY: false,
    ADVANCED_ROUTING: false,
    AGENT_MARKETPLACE: false,
  },
  /** SaaS build — all features enabled. */
  saas: {
    GATEWAY_INTELLIGENCE: true,
    TRAJECTORY_CAPTURE: true,
    SAAS_ANALYTICS: true,
    CLOUD_MEMORY: true,
    ADVANCED_ROUTING: true,
    AGENT_MARKETPLACE: true,
  },
  /** Dev build — all features enabled (matches runtime defaults). */
  dev: {
    GATEWAY_INTELLIGENCE: true,
    TRAJECTORY_CAPTURE: true,
    SAAS_ANALYTICS: true,
    CLOUD_MEMORY: true,
    ADVANCED_ROUTING: true,
    AGENT_MARKETPLACE: true,
  },
};

/**
 * Generate the tsup `define` map for a given build target.
 *
 * Returns entries like `{ '__FEATURE_GATEWAY_INTELLIGENCE__': 'false' }`.
 * tsup (via esbuild) replaces every occurrence of the identifier with the
 * literal string, enabling dead-code elimination on `if (false)` branches.
 */
export function getFeatureDefines(
  target: "oss" | "saas" | "dev",
): Record<string, string> {
  const profile = PROFILES[target];
  const defines: Record<string, string> = {};

  for (const [name, enabled] of Object.entries(profile)) {
    defines[`__FEATURE_${name}__`] = String(enabled);
  }

  return defines;
}

/**
 * Convenience: merge feature defines with your existing define map.
 */
export function withFeatureDefines(
  target: "oss" | "saas" | "dev",
  existing?: Record<string, string>,
): Record<string, string> {
  return { ...existing, ...getFeatureDefines(target) };
}
