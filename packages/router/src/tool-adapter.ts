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

/**
 * Translate a provider-specific tool-call name back to its canonical
 * (Anthropic) name for the given model's family, without needing to have
 * a reverseMap in hand.
 *
 * This is the INBOUND counterpart to adaptToolsForModel: the loop renames
 * tools OUTBOUND so the model sees provider-native names (file_edit →
 * apply_patch for OpenAI, file_edit → replace for Google, etc.); when the
 * model then emits a tool call under that renamed name, dispatch/tracking
 * must map it BACK to the canonical name or the loop's tool-name comparisons
 * (file_read/file_write/shell/subagent) and executor lookup miss.
 *
 * Anthropic (and any unmapped provider) round-trips unchanged. Names with no
 * provider mapping (already canonical, or genuinely unknown) pass through.
 *
 * @param providerName - The tool name as emitted by the model
 * @param model - The model that produced the tool call
 * @returns The canonical Brainstorm tool name
 */
export function reverseToolName(
  providerName: string,
  model: ModelEntry,
): string {
  const family = getProviderFamily(model.provider);
  const mapping = PROVIDER_TOOL_NAMES[family];
  if (!mapping) return providerName;
  for (const [canonicalName, adaptedName] of Object.entries(mapping)) {
    if (adaptedName === providerName) return canonicalName;
  }
  return providerName;
}
