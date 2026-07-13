import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelEntry } from "@brainst0rm/shared";
import { parseBrEnvelope, type BrEnvelopeListener } from "./br-envelope.js";

/** BrainstormRouter SaaS base URL (OpenAI-compatible surface). */
export const BR_BASE_URL = "https://api.brainstormrouter.com/v1";

/**
 * BrainstormRouter sends a "guardian" SSE event after [DONE] with cost/audit metadata.
 * The AI SDK's parser can't handle it and hangs or throws.
 *
 * Fix: simple line-level filter that drops any SSE data line containing guardian JSON
 * and any event: guardian lines. Operates on raw text, no buffering needed.
 *
 * 2026-05-15: the wrapper now also extracts the `x-br-*` response envelope
 * (~33 headers carrying routing/cost/quality/audit/deprecation signals) and
 * fires `onEnvelope` per response. Before this, every chat turn received the
 * full envelope and discarded it — the path-to-90 P1 fix. The listener is
 * optional; if absent, the envelope is parsed-and-dropped (cheap; ~33 string
 * lookups + a few JSON parses). Errors in the listener are caught and
 * logged-to-console-error rather than escaping into the fetch path.
 */
export function createGuardianFilterFetch(
  onEnvelope?: BrEnvelopeListener,
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const response = await globalThis.fetch(input, init);

    // Capture the BR envelope BEFORE we do anything else with the response —
    // it lives entirely in the headers, regardless of body shape (streaming
    // SSE or one-shot JSON). If the caller didn't supply a listener, the
    // parse still runs (so the ratchet stays exercised) and the result is
    // discarded.
    //
    // Listener invocation is fire-and-forget. The fetch path NEVER awaits
    // the listener — per-turn cost telemetry must not block the request.
    // Async rejections are flattened via Promise.resolve().catch() so a
    // misbehaving async listener cannot escape as an unhandled rejection.
    try {
      const envelope = parseBrEnvelope(response.headers);
      if (onEnvelope) {
        Promise.resolve()
          .then(() => onEnvelope(envelope))
          .catch((err) =>
            console.error("[brainstorm-saas] envelope listener threw:", err),
          );
      }
    } catch (err) {
      // Defensive: never let envelope-parser errors leak into the AI SDK
      // fetch path. Log via stderr so ops can see them in the CLI.
      console.error("[brainstorm-saas] envelope parser threw:", err);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    // Buffered line parser — SSE frames may span chunk boundaries
    let lineBuffer = "";

    const filteredStream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush remaining buffer on stream end
          if (lineBuffer.trim()) {
            controller.enqueue(encoder.encode(lineBuffer));
          }
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });

        // Fast path: most chunks don't contain guardian data
        if (
          !text.includes("guardian") &&
          !text.includes(": guardian") &&
          !lineBuffer
        ) {
          controller.enqueue(value);
          return;
        }

        // Slow path: buffered line-by-line filtering
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        // Last element may be incomplete — keep it in the buffer
        lineBuffer = lines.pop() ?? "";

        const kept: string[] = [];
        for (const line of lines) {
          // Drop event: guardian lines
          if (
            line.startsWith("event: guardian") ||
            line.startsWith("event:guardian")
          )
            continue;
          // Drop SSE comments with guardian prefix
          if (line.startsWith(": guardian")) continue;
          // Drop data lines containing guardian JSON
          if (line.startsWith("data: ") && line.includes('"guardian"')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed && typeof parsed === "object" && "guardian" in parsed)
                continue;
            } catch {
              /* not JSON, pass through */
            }
          }
          kept.push(line);
        }

        const filtered = kept.join("\n") + "\n";
        if (filtered.trim()) {
          controller.enqueue(encoder.encode(filtered));
        }
      },
      cancel() {
        reader.cancel();
      },
    });

    return new Response(filteredStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * BrainstormRouter SaaS provider.
 *
 * Uses OpenAI-compatible API at api.brainstormrouter.com. The custom fetch
 * wrapper does two things:
 *   1. Captures the `x-br-*` response envelope (routing/cost/quality/audit/
 *      deprecation signals) and fires `onEnvelope` per response. See
 *      `./br-envelope.ts` for the typed shape.
 *   2. Filters the "guardian" SSE event the AI SDK parser cannot handle.
 *
 * Both apply to every response. `onEnvelope` is optional; absent → parsed-
 * and-dropped (cheap). Errors in the listener are logged and swallowed.
 */
export function createBrainstormSaaSProvider(
  apiKey: string,
  options: { onEnvelope?: BrEnvelopeListener } = {},
) {
  return createOpenAICompatible({
    name: "brainstormrouter",
    baseURL: BR_BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    fetch: createGuardianFilterFetch(options.onEnvelope),
  });
}

// ── BR model catalog import ──────────────────────────────────────────
//
// BR exposes an OpenAI-compatible `GET /v1/models`. Beyond the base OpenAI
// shape (`{ object: "list", data: [{ id, owned_by, ... }] }`) BR annotates
// each entry with best-effort capability metadata. We synthesize a
// ModelEntry per returned model so the router can *see* and *select* any
// tool-capable model BR serves — not just the statically curated CLOUD_MODELS.
//
// The shape below is intentionally loose: BR may nest capability hints under
// `capabilities`, expose flat flags, or list a `features` array. We read all
// three, and default toolCalling=false unless the catalog explicitly says
// otherwise (conservative — a false positive would let the router pick a
// model that then rejects tool calls at runtime).

interface BrCatalogResponse {
  object?: string;
  data?: unknown[];
}

/** Options for {@link fetchBrModelCatalog}. All injectable for tests. */
export interface BrCatalogOptions {
  /** Override the global fetch (tests stub this). */
  fetchImpl?: typeof globalThis.fetch;
  /** Abort the request after this many ms. Default 5000. */
  timeoutMs?: number;
  /** Override the base URL. Default {@link BR_BASE_URL}. */
  baseUrl?: string;
}

/** Does a catalog entry explicitly advertise tool/function calling? */
function catalogAdvertisesToolCalling(entry: Record<string, unknown>): boolean {
  const truthyFlag = (v: unknown): boolean => v === true;
  const caps =
    entry.capabilities && typeof entry.capabilities === "object"
      ? (entry.capabilities as Record<string, unknown>)
      : undefined;

  if (caps) {
    if (
      truthyFlag(caps.tool_calling) ||
      truthyFlag(caps.toolCalling) ||
      truthyFlag(caps.tools) ||
      truthyFlag(caps.function_calling) ||
      truthyFlag(caps.functionCalling)
    )
      return true;
  }
  if (
    truthyFlag(entry.tool_calling) ||
    truthyFlag(entry.supports_tools) ||
    truthyFlag(entry.function_calling)
  )
    return true;

  const features = (entry.features ?? caps?.features) as unknown;
  if (Array.isArray(features)) {
    const norm = features.map((f) => String(f).toLowerCase());
    if (
      norm.some(
        (f) =>
          f === "tools" ||
          f === "tool_calling" ||
          f === "tool-calling" ||
          f === "function_calling" ||
          f === "function-calling",
      )
    )
      return true;
  }
  return false;
}

/** Does a catalog entry explicitly advertise vision/image input? */
function catalogAdvertisesVision(entry: Record<string, unknown>): boolean {
  const caps =
    entry.capabilities && typeof entry.capabilities === "object"
      ? (entry.capabilities as Record<string, unknown>)
      : undefined;
  if (caps && (caps.vision === true || caps.image_input === true)) return true;
  if (entry.vision === true) return true;
  const features = (entry.features ?? caps?.features) as unknown;
  if (Array.isArray(features)) {
    const norm = features.map((f) => String(f).toLowerCase());
    if (norm.some((f) => f === "vision" || f === "image" || f === "images"))
      return true;
  }
  return false;
}

/** Provider derived from the id prefix ("openai/gpt-4.1" → "openai"). */
function providerFromId(id: string): string {
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  return "brainstormrouter";
}

function synthesizeModelEntry(entry: Record<string, unknown>): ModelEntry {
  const id = String(entry.id);
  const toolCalling = catalogAdvertisesToolCalling(entry);
  const vision = catalogAdvertisesVision(entry);
  const contextWindow =
    typeof entry.context_window === "number"
      ? entry.context_window
      : typeof entry.context_length === "number"
        ? entry.context_length
        : 128000;
  const maxOutputTokens =
    typeof entry.max_output_tokens === "number"
      ? entry.max_output_tokens
      : 16384;

  return {
    id,
    provider: providerFromId(id),
    name: typeof entry.name === "string" ? entry.name : id,
    capabilities: {
      toolCalling,
      streaming: true,
      vision,
      reasoning: false,
      contextWindow,
      // Neutral tiers — BR-discovered models have no curated quality/speed
      // ranking. The router still gates them by toolCalling above.
      qualityTier: 3,
      speedTier: 3,
      bestFor: [],
    },
    // Placeholder pricing — real cost comes from BR reconcile (x-br-* envelope).
    pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
    limits: { contextWindow, maxOutputTokens },
    status: "available",
    isLocal: false,
    lastHealthCheck: Date.now(),
  };
}

/**
 * Fetch BR's `GET /v1/models` and synthesize a ModelEntry per model.
 *
 * Resilient by contract: any failure (network error, timeout, non-2xx,
 * malformed body, absent key) resolves to an empty array rather than
 * throwing — the caller keeps its static catalog. Never blocks registry
 * construction on a bad connection.
 */
export async function fetchBrModelCatalog(
  apiKey: string,
  options: BrCatalogOptions = {},
): Promise<ModelEntry[]> {
  if (!apiKey) return [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? BR_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 5000;

  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];

    const body = (await response.json()) as BrCatalogResponse;
    const data = Array.isArray(body?.data) ? body.data : [];

    const entries: ModelEntry[] = [];
    const seen = new Set<string>();
    for (const raw of data) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      if (typeof rec.id !== "string" || rec.id.length === 0) continue;
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      entries.push(synthesizeModelEntry(rec));
    }
    return entries;
  } catch {
    // Network failure / timeout / malformed JSON — skip silently. Keeping
    // the static catalog is always safe; a partial BR catalog is not worth
    // blocking startup for.
    return [];
  }
}

// Re-export the parser surface so callers can build typed envelope handlers
// without depending on the internal path. Keep this list minimal.
export {
  parseBrEnvelope,
  CANONICAL_BR_HEADERS,
  KNOWN_OPTIONAL_BR_HEADERS,
  type BrEnvelope,
  type BrEnvelopeListener,
} from "./br-envelope.js";

/**
 * Community tier API key — INTENTIONALLY PUBLIC.
 *
 * This key is rate-limited and budget-capped at the BrainstormRouter
 * infrastructure level. It enables zero-config onboarding for new users
 * who haven't set up their own API keys yet. It has:
 * - 10 RPM rate limit
 * - $5/month budget cap
 * - Community-tier scopes only (no admin access)
 * - Usage attributed to "community" tenant (not a personal account)
 *
 * This is the standard pattern for OSS tools with a SaaS backend
 * (e.g., Sentry DSN, PostHog project key). The key is safe to commit.
 */
const COMMUNITY_KEY =
  "br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a";

export function getBrainstormApiKey(): string {
  return process.env.BRAINSTORM_API_KEY ?? COMMUNITY_KEY;
}

export function isCommunityKey(key: string): boolean {
  return key === COMMUNITY_KEY;
}
