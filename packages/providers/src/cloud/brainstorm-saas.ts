import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * BrainstormRouter sends a "guardian" SSE event after [DONE] with cost/audit metadata.
 * The AI SDK's parser can't handle it and hangs or throws.
 *
 * Fix: simple line-level filter that drops any SSE data line containing guardian JSON
 * and any event: guardian lines. Operates on raw text, no buffering needed.
 */
function createGuardianFilterFetch(): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const response = await globalThis.fetch(input, init);

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
 * Uses OpenAI-compatible API at api.brainstormrouter.com.
 * Includes a custom fetch wrapper that filters out guardian SSE events.
 */
export function createBrainstormSaaSProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "brainstormrouter",
    baseURL: "https://api.brainstormrouter.com/v1",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    fetch: createGuardianFilterFetch(),
  });
}

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
