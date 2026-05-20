import type { ModelEntry } from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("br-catalog");

const DEFAULT_BR_BASE_URL = "https://api.brainstormrouter.com";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Wire shape of an entry in BR's `/v1/models` response. Matches the
 * actual production payload at api.brainstormrouter.com:
 *
 *   { id, object, created, owned_by, x_model_router: { pricing, capabilities, endpoints } }
 *
 * `x_model_router` is BR's vendor extension to the OpenAI /v1/models
 * format and may be absent for very stripped-down catalog entries; both
 * paths are handled by the merge logic.
 */
export interface BrCatalogEntry {
  id: string;
  owned_by?: string;
  x_model_router?: {
    pricing?: { input?: number; output?: number };
    capabilities?: string[];
    endpoints?: number;
  };
}

interface BrCatalogResponse {
  data?: BrCatalogEntry[];
}

/**
 * Fetch BR's live model catalog. Returns `null` on any failure
 * (network, non-200, malformed body) so callers can fall back to the
 * static CLOUD_MODELS list without a try/catch dance. Failures are
 * logged at warn level — they're not fatal because brainstorm should
 * still work offline against direct provider keys.
 */
export async function fetchBrCatalog(
  apiKey: string,
  baseUrl: string = DEFAULT_BR_BASE_URL,
): Promise<BrCatalogEntry[] | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status },
        "BR /v1/models returned non-OK; using static fallback",
      );
      return null;
    }
    const body = (await res.json()) as BrCatalogResponse;
    if (!Array.isArray(body.data)) {
      log.warn(
        { body: JSON.stringify(body).slice(0, 200) },
        "BR /v1/models response missing data[]",
      );
      return null;
    }
    return body.data;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "BR /v1/models fetch failed; using static fallback",
    );
    return null;
  }
}

/**
 * Map a BR catalog entry to a brainstorm ModelEntry, overlaying local
 * capability metadata (qualityTier, speedTier, bestFor, capabilityScores)
 * from CLOUD_MODELS when an entry with the same id exists. BR provides
 * the authoritative model id, owned_by, pricing, and coarse capability
 * flags; the local overlay carries the heuristics brainstorm's router
 * uses for strategy selection (which BR doesn't track).
 */
export function brEntryToModel(
  br: BrCatalogEntry,
  overlay: Map<string, ModelEntry>,
): ModelEntry {
  const local = overlay.get(br.id);
  const caps = new Set(br.x_model_router?.capabilities ?? []);
  const provider = br.owned_by ?? br.id.split("/")[0] ?? "unknown";

  const toolCalling =
    caps.has("tools") ||
    caps.has("functionCalling") ||
    local?.capabilities.toolCalling ||
    false;
  const streaming =
    caps.has("streaming") || local?.capabilities.streaming || true;
  const vision = caps.has("vision") || local?.capabilities.vision || false;

  return {
    id: br.id,
    provider,
    name: local?.name ?? prettyNameFromId(br.id),
    capabilities: {
      toolCalling,
      streaming,
      vision,
      reasoning: local?.capabilities.reasoning ?? false,
      contextWindow: local?.capabilities.contextWindow ?? 128_000,
      qualityTier: local?.capabilities.qualityTier ?? 2,
      speedTier: local?.capabilities.speedTier ?? 2,
      bestFor: local?.capabilities.bestFor ?? [
        "code-generation",
        "conversation",
      ],
      ...(local?.capabilities.capabilityScores
        ? { capabilityScores: local.capabilities.capabilityScores }
        : {}),
    },
    pricing: {
      inputPer1MTokens:
        br.x_model_router?.pricing?.input ??
        local?.pricing.inputPer1MTokens ??
        0,
      outputPer1MTokens:
        br.x_model_router?.pricing?.output ??
        local?.pricing.outputPer1MTokens ??
        0,
      ...(local?.pricing.cachedInputPer1MTokens != null
        ? { cachedInputPer1MTokens: local.pricing.cachedInputPer1MTokens }
        : {}),
    },
    limits: local?.limits ?? {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    },
    status: "available",
    isLocal: false,
    lastHealthCheck: Date.now(),
  };
}

/**
 * Merge BR's live catalog with the local CLOUD_MODELS overlay. Returns
 * one ModelEntry per id present in BR's catalog. Local-only models
 * (in CLOUD_MODELS but not in BR) are NOT included — BR is the source
 * of truth for which models brainstorm can actually call via SaaS.
 */
export function mergeBrCatalog(
  brEntries: BrCatalogEntry[],
  localModels: ModelEntry[],
): ModelEntry[] {
  const overlay = new Map(localModels.map((m) => [m.id, m]));
  return brEntries.map((br) => brEntryToModel(br, overlay));
}

function prettyNameFromId(id: string): string {
  const [, ...rest] = id.split("/");
  return rest.join("/") || id;
}
