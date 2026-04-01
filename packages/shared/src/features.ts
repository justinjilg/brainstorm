/**
 * Compile-time feature flags for open-core gating.
 *
 * In production builds, tsup's `define` replaces these with `false`,
 * allowing the bundler to dead-code eliminate gated branches.
 *
 * Usage:
 *   if (feature('GATEWAY_INTELLIGENCE')) {
 *     // This code is stripped from open-source builds
 *   }
 */

// --- Feature flag names (union type) ---

export type FeatureName =
  | "GATEWAY_INTELLIGENCE"
  | "TRAJECTORY_CAPTURE"
  | "SAAS_ANALYTICS"
  | "CLOUD_MEMORY"
  | "ADVANCED_ROUTING"
  | "AGENT_MARKETPLACE";

// --- Compile-time constants ---
// tsup `define` replaces these globals at build time.
// Declared with `var` so tsup's define can substitute them directly.

declare var __FEATURE_GATEWAY_INTELLIGENCE__: boolean;
declare var __FEATURE_TRAJECTORY_CAPTURE__: boolean;
declare var __FEATURE_SAAS_ANALYTICS__: boolean;
declare var __FEATURE_CLOUD_MEMORY__: boolean;
declare var __FEATURE_ADVANCED_ROUTING__: boolean;
declare var __FEATURE_AGENT_MARKETPLACE__: boolean;

// --- Runtime defaults (used when globals are not replaced by tsup) ---

const DEFAULTS: Record<FeatureName, boolean> = {
  GATEWAY_INTELLIGENCE: true,
  TRAJECTORY_CAPTURE: true,
  SAAS_ANALYTICS: true,
  CLOUD_MEMORY: true,
  ADVANCED_ROUTING: true,
  AGENT_MARKETPLACE: true,
};

/**
 * Parse the BRAINSTORM_FEATURES env var into a Set of enabled feature names.
 * Returns null if the env var is not set (meaning: use defaults).
 */
function parseEnvOverrides(): Set<FeatureName> | null {
  const raw =
    typeof process !== "undefined" && process.env?.BRAINSTORM_FEATURES;
  if (!raw) return null;
  const names = raw.split(",").map((s) => s.trim()) as FeatureName[];
  return new Set(names);
}

const envOverrides = parseEnvOverrides();

/**
 * Resolve a feature flag's value.
 *
 * Resolution order:
 *  1. Compile-time constant (if tsup replaced the global)
 *  2. BRAINSTORM_FEATURES env var (comma-separated allowlist)
 *  3. Default (true in development — all features enabled)
 */
function resolve(name: FeatureName): boolean {
  // 1. Check compile-time constants.
  //    When tsup replaces a global with a literal boolean the typeof check
  //    lets us detect whether it was replaced (literal `true`/`false` has
  //    typeof "boolean") vs left as an undeclared identifier (typeof "undefined").
  switch (name) {
    case "GATEWAY_INTELLIGENCE":
      if (typeof __FEATURE_GATEWAY_INTELLIGENCE__ !== "undefined")
        return __FEATURE_GATEWAY_INTELLIGENCE__;
      break;
    case "TRAJECTORY_CAPTURE":
      if (typeof __FEATURE_TRAJECTORY_CAPTURE__ !== "undefined")
        return __FEATURE_TRAJECTORY_CAPTURE__;
      break;
    case "SAAS_ANALYTICS":
      if (typeof __FEATURE_SAAS_ANALYTICS__ !== "undefined")
        return __FEATURE_SAAS_ANALYTICS__;
      break;
    case "CLOUD_MEMORY":
      if (typeof __FEATURE_CLOUD_MEMORY__ !== "undefined")
        return __FEATURE_CLOUD_MEMORY__;
      break;
    case "ADVANCED_ROUTING":
      if (typeof __FEATURE_ADVANCED_ROUTING__ !== "undefined")
        return __FEATURE_ADVANCED_ROUTING__;
      break;
    case "AGENT_MARKETPLACE":
      if (typeof __FEATURE_AGENT_MARKETPLACE__ !== "undefined")
        return __FEATURE_AGENT_MARKETPLACE__;
      break;
  }

  // 2. Env var override (allowlist — only listed features are enabled).
  if (envOverrides !== null) {
    return envOverrides.has(name);
  }

  // 3. Default.
  return DEFAULTS[name];
}

/**
 * Check whether a feature is enabled.
 *
 * When the compile-time constant has been replaced by tsup, the bundler
 * can see `if (false) { ... }` and tree-shake the dead branch entirely.
 */
export function feature(name: FeatureName): boolean {
  return resolve(name);
}

/** All known feature names (useful for iteration / tooling). */
export const ALL_FEATURES: readonly FeatureName[] = [
  "GATEWAY_INTELLIGENCE",
  "TRAJECTORY_CAPTURE",
  "SAAS_ANALYTICS",
  "CLOUD_MEMORY",
  "ADVANCED_ROUTING",
  "AGENT_MARKETPLACE",
] as const;
