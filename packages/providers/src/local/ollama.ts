import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelEntry } from "@brainst0rm/shared";

export function createOllamaProvider(baseUrl = "http://localhost:11434") {
  return createOpenAICompatible({
    name: "ollama",
    baseURL: `${baseUrl}/v1`,
  });
}

export async function discoverOllamaModels(
  baseUrl = "http://localhost:11434",
): Promise<ModelEntry[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        size: number;
        details?: { parameter_size?: string; family?: string };
      }>;
    };
    if (!data.models) return [];

    return data.models.map((m) => {
      const paramSize = m.details?.parameter_size ?? "";
      const tier = inferQualityTier(paramSize);
      return {
        id: `ollama:${m.name}`,
        provider: "ollama",
        name: m.name,
        capabilities: {
          toolCalling: true,
          streaming: true,
          vision: m.name.includes("vision") || m.name.includes("llava"),
          reasoning: tier <= 2,
          contextWindow: inferContextWindow(m.name),
          qualityTier: tier,
          speedTier: inferSpeedTier(paramSize),
          bestFor: inferBestFor(m.name, tier),
        },
        pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
        limits: {
          contextWindow: inferContextWindow(m.name),
          maxOutputTokens: 4096,
        },
        status: "available" as const,
        isLocal: true,
        lastHealthCheck: Date.now(),
      };
    });
  } catch {
    return [];
  }
}

function inferQualityTier(paramSize: string): 1 | 2 | 3 | 4 | 5 {
  const size = paramSize.toLowerCase();
  if (size.includes("70b") || size.includes("72b")) return 2;
  if (size.includes("32b") || size.includes("34b")) return 2;
  if (size.includes("13b") || size.includes("14b")) return 3;
  if (size.includes("7b") || size.includes("8b")) return 4;
  if (size.includes("3b") || size.includes("1b")) return 5;
  return 3;
}

function inferSpeedTier(paramSize: string): 1 | 2 | 3 | 4 | 5 {
  const size = paramSize.toLowerCase();
  if (size.includes("1b") || size.includes("3b")) return 1;
  if (size.includes("7b") || size.includes("8b")) return 2;
  if (size.includes("13b") || size.includes("14b")) return 3;
  if (size.includes("32b") || size.includes("34b")) return 4;
  if (size.includes("70b") || size.includes("72b")) return 5;
  return 3;
}

function inferContextWindow(name: string): number {
  if (name.includes("128k")) return 131072;
  if (name.includes("32k")) return 32768;
  return 8192;
}

function inferBestFor(
  name: string,
  tier: number,
): Array<
  "simple-edit" | "code-generation" | "explanation" | "conversation" | "search"
> {
  const best: Array<
    | "simple-edit"
    | "code-generation"
    | "explanation"
    | "conversation"
    | "search"
  > = ["conversation"];
  if (
    name.includes("code") ||
    name.includes("coder") ||
    name.includes("deepseek")
  ) {
    best.push("code-generation", "simple-edit");
  }
  if (tier <= 3) best.push("explanation");
  return best;
}
