/**
 * Subagent tool-name adaptation.
 *
 * spawnSubagent must mirror the parent loop's per-model tool-name handling:
 *   - OUTBOUND: rename canonical tools to the provider-native names the
 *     subagent's model was trained on (file_read → read_file for OpenAI),
 *     so a non-Anthropic subagent model can actually call its tools.
 *   - INBOUND: reverse-map observed tool-call names back to canonical so the
 *     subagent's reported toolCalls use the parent's canonical vocabulary.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let _streamParts: any[] = [];

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((_opts: any) => {
      // Intentionally do NOT invoke onStepFinish: it would drive a cost
      // record against the subagent's dynamic session id, which isn't in the
      // sessions table (FK). Tool-name adaptation doesn't depend on it.
      async function* fullStream() {
        for (const ev of _streamParts) yield ev;
      }
      return {
        fullStream: fullStream(),
        textStream: (async function* () {})(),
        text: Promise.resolve(""),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({ headers: new Map() }),
      };
    }),
  };
});

import { streamText } from "ai";
import { spawnSubagent } from "../agent/subagent.js";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { getTestDb } from "@brainst0rm/db";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type { ModelEntry } from "@brainst0rm/shared";

function buildCtx() {
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-subagent-"));
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "brainstorm-home-"));
  process.env.HOME = fakeHome;

  const config: Partial<BrainstormConfig> = {
    general: { maxSteps: 3 } as any,
    budget: { hardLimit: false } as any,
    routing: { rules: [] } as any,
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 } as any,
  };

  const openaiModel: ModelEntry = {
    id: "openai/gpt-5.4",
    provider: "openai",
    name: "GPT-5.4",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: false,
      contextWindow: 128000,
      qualityTier: 3,
      speedTier: 2,
      bestFor: ["code-generation"],
    },
    pricing: { inputPer1MTokens: 1, outputPer1MTokens: 3 },
    limits: { contextWindow: 128000, maxOutputTokens: 4000 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  };

  const registry: Partial<ProviderRegistry> = {
    models: [openaiModel],
    getModel: (id: string) => (id === openaiModel.id ? openaiModel : undefined),
    getProvider: () => ({}) as any,
  };

  const db = getTestDb();
  const costTracker = new CostTracker(db, config.budget as any);
  const router = new BrainstormRouter(
    config as any,
    registry as any,
    costTracker,
  );

  // Canonical-keyed tools; the adapter renames these for OpenAI.
  const canonicalTools = {
    file_read: { execute: async () => "content", description: "Read a file" },
    glob: { execute: async () => [], description: "Find files" },
    grep: { execute: async () => [], description: "Search content" },
  };
  const tools: any = {
    toAISDKToolsFiltered: (_names: string[]) => ({ ...canonicalTools }),
    toAISDKToolsWithPermissions: (_check: any, _names: string[]) => ({
      ...canonicalTools,
    }),
    toAISDKTools: () => ({ ...canonicalTools }),
  };

  return {
    cleanup: () => {
      rmSync(tmpProjectPath, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome) process.env.HOME = originalHome;
    },
    config,
    registry,
    router,
    costTracker,
    tools,
    tmpProjectPath,
  };
}

describe("subagent — per-model tool-name adaptation", () => {
  let ctx: ReturnType<typeof buildCtx>;
  beforeEach(() => {
    _streamParts = [];
    (streamText as any).mockClear();
    ctx = buildCtx();
  });
  afterEach(() => ctx.cleanup());

  it("adapts OUTBOUND tool names for the subagent's provider", async () => {
    _streamParts = [];
    await spawnSubagent("look around", {
      config: ctx.config as any,
      registry: ctx.registry as any,
      router: ctx.router,
      costTracker: ctx.costTracker,
      tools: ctx.tools as any,
      projectPath: ctx.tmpProjectPath,
      type: "explore", // read-only; includes file_read
      preferredModelId: "openai/gpt-5.4",
    });

    const call = (streamText as any).mock.calls.at(-1)?.[0];
    expect(call, "streamText must have been called").toBeDefined();
    const toolKeys = Object.keys(call.tools ?? {});
    // file_read must have been renamed to OpenAI's read_file.
    expect(toolKeys).toContain("read_file");
    expect(toolKeys).not.toContain("file_read");
    // Unmapped tools pass through unchanged.
    expect(toolKeys).toContain("glob");
  });

  it("reverse-maps INBOUND tool-call names back to canonical", async () => {
    _streamParts = [
      { type: "tool-call", toolName: "read_file", input: { path: "/a.ts" } },
    ];
    const result = await spawnSubagent("read a.ts", {
      config: ctx.config as any,
      registry: ctx.registry as any,
      router: ctx.router,
      costTracker: ctx.costTracker,
      tools: ctx.tools as any,
      projectPath: ctx.tmpProjectPath,
      type: "explore",
      preferredModelId: "openai/gpt-5.4",
    });

    // The model called "read_file"; the subagent must report canonical name.
    expect(result.toolCalls).toContain("file_read");
    expect(result.toolCalls).not.toContain("read_file");
  });
});
