import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * BrainstormRouter sends a "guardian" SSE event after [DONE] with cost/audit metadata.
 * The AI SDK's OpenAI-compatible parser can't handle this non-standard event and throws
 * a TypeValidationError, which kills multi-step tool calling (step 2+ never runs).
 *
 * Fix: wrap the response body stream to filter out guardian JSON lines before they
 * reach the AI SDK parser. Guardian events are identified by containing a "guardian"
 * key at the top level of the parsed JSON.
 */
function createGuardianFilterFetch(): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const response = await globalThis.fetch(input, init);

    // Only filter streaming responses
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const filteredStream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            // Flush any remaining buffer
            if (buffer.trim()) {
              const filtered = filterGuardianLines(buffer);
              if (filtered) controller.enqueue(encoder.encode(filtered));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines (delimited by double newlines)
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? ''; // Keep incomplete part in buffer

          for (const part of parts) {
            const filtered = filterGuardianLines(part);
            if (filtered) {
              controller.enqueue(encoder.encode(filtered + '\n\n'));
            }
          }
        } catch (err) {
          controller.error(err);
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

/** Filter out SSE data lines that contain guardian metadata. */
function filterGuardianLines(sseBlock: string): string | null {
  const lines = sseBlock.split('\n');
  const filtered: string[] = [];

  for (const line of lines) {
    // SSE data lines start with "data: "
    if (line.startsWith('data: ')) {
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') {
        filtered.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && 'guardian' in parsed) {
          // Skip guardian metadata event
          continue;
        }
      } catch {
        // Not valid JSON — pass through
      }
    }
    filtered.push(line);
  }

  const result = filtered.join('\n').trim();
  return result || null;
}

/**
 * BrainstormRouter SaaS provider.
 * Uses OpenAI-compatible API at api.brainstormrouter.com.
 * Supports model="auto" for intelligent routing by the SaaS.
 * Includes a custom fetch wrapper that filters out guardian SSE events
 * that would otherwise crash the AI SDK's stream parser.
 */
export function createBrainstormSaaSProvider(apiKey: string) {
  return createOpenAICompatible({
    name: 'brainstormrouter',
    baseURL: 'https://api.brainstormrouter.com/v1',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    fetch: createGuardianFilterFetch(),
  });
}

/**
 * Community tier API key — ships with the CLI for zero-setup onboarding.
 * Rate-limited server-side by BrainstormRouter: 5 RPM, 100 req/day, $2/day,
 * cheap models only (DeepSeek V3, Haiku, GPT-4.1-mini, Gemini Flash).
 * Users override with BRAINSTORM_API_KEY for full access to 357 models.
 */
const COMMUNITY_KEY = 'br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a';

/**
 * Get the BrainstormRouter API key.
 * Priority: BRAINSTORM_API_KEY env var → community key (free tier).
 */
export function getBrainstormApiKey(): string {
  return process.env.BRAINSTORM_API_KEY ?? COMMUNITY_KEY;
}

/**
 * Check if the current key is the community tier (for UI messaging).
 */
export function isCommunityKey(key: string): boolean {
  return key === COMMUNITY_KEY;
}
