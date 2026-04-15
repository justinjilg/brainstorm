/**
 * Per-Model Tool Name Adapter.
 *
 * When BrainstormRouter routes to a non-Anthropic model, this adapter
 * renames tools to match the conventions each model was trained on.
 * Returns adapted tools + a reverse map for translating tool calls back
 * to canonical names for execution, trajectory recording, and middleware.
 *
 * Anthropic models use canonical names — no adaptation needed.
 */

import type { ModelEntry } from "@brainst0rm/shared";
import { PROVIDER_TOOL_NAMES, getProviderFamily } from "./tool-mappings.js";

export interface ToolAdaptation {
  /** Tools with provider-specific names. Same object if no mapping needed. */
  adaptedTools: Record<string, any>;
  /** Maps provider-specific name → canonical name. Empty if no mapping. */
  reverseMap: Map<string, string>;
}

/**
 * Adapt tool names for a specific model's provider.
 *
 * @param tools - AI SDK ToolSet keyed by canonical (Anthropic) names
 * @param model - The target model from routing decision
 * @returns Adapted tools + reverse map for translating back
 */
export function adaptToolsForModel(
  tools: Record<string, any>,
  model: ModelEntry,
): ToolAdaptation {
  const family = getProviderFamily(model.provider);
  const mapping = PROVIDER_TOOL_NAMES[family];

  // No mapping for this provider (e.g., anthropic) — return as-is
  if (!mapping) {
    return { adaptedTools: tools, reverseMap: new Map() };
  }

  const adaptedTools: Record<string, any> = {};
  const reverseMap = new Map<string, string>();

  for (const [canonicalName, toolObj] of Object.entries(tools)) {
    const adaptedName = mapping[canonicalName] ?? canonicalName;
    adaptedTools[adaptedName] = toolObj;

    if (adaptedName !== canonicalName) {
      reverseMap.set(adaptedName, canonicalName);
    }
  }

  return { adaptedTools, reverseMap };
}

/**
 * Resolve a tool name from the model's response back to canonical.
 * If no mapping exists, returns the name unchanged.
 */
export function resolveCanonicalName(
  providerName: string,
  reverseMap: Map<string, string>,
): string {
  return reverseMap.get(providerName) ?? providerName;
}
