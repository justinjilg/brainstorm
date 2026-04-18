import { describe, it, expect } from "vitest";
import { adaptToolsForModel, resolveCanonicalName } from "../tool-adapter.js";
import { getProviderFamily } from "../tool-mappings.js";
import type { ModelEntry } from "@brainst0rm/shared";

function mockModel(provider: string): ModelEntry {
  // `as unknown as ModelEntry` is deliberate — this test's scope is
  // the adapter's behavior for the provider/capabilities slice only.
  // Providing a minimal shape keeps the test focused; in exchange we
  // name the cast explicitly so no one mistakes this for a real model.
  return {
    id: `${provider}/test-model`,
    provider,
    name: "Test Model",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      contextWindow: 128000,
    },
    pricing: { inputPer1M: 1, outputPer1M: 3 },
    qualityTier: "high",
  } as unknown as ModelEntry;
}

function mockTools() {
  return {
    bash: { execute: async () => "ok", description: "Run shell command" },
    file_read: { execute: async () => "content", description: "Read a file" },
    file_write: { execute: async () => "done", description: "Write a file" },
    file_edit: { execute: async () => "edited", description: "Edit a file" },
    glob: { execute: async () => [], description: "Find files" },
    grep: { execute: async () => [], description: "Search content" },
  };
}

describe("tool-adapter", () => {
  describe("adaptToolsForModel", () => {
    it("returns tools unchanged for Anthropic models", () => {
      const tools = mockTools();
      const { adaptedTools, reverseMap } = adaptToolsForModel(
        tools,
        mockModel("anthropic"),
      );
      expect(adaptedTools).toBe(tools); // same reference
      expect(reverseMap.size).toBe(0);
    });

    it("renames tools for OpenAI models", () => {
      const tools = mockTools();
      const { adaptedTools, reverseMap } = adaptToolsForModel(
        tools,
        mockModel("openai"),
      );

      // Renamed tools
      expect(adaptedTools).toHaveProperty("shell_command");
      expect(adaptedTools).toHaveProperty("read_file");
      expect(adaptedTools).toHaveProperty("write_file");
      expect(adaptedTools).toHaveProperty("apply_patch");

      // Original names removed
      expect(adaptedTools).not.toHaveProperty("bash");
      expect(adaptedTools).not.toHaveProperty("file_read");
      expect(adaptedTools).not.toHaveProperty("file_write");
      expect(adaptedTools).not.toHaveProperty("file_edit");

      // Unmapped tools pass through
      expect(adaptedTools).toHaveProperty("glob");
      expect(adaptedTools).toHaveProperty("grep");

      // Reverse map
      expect(reverseMap.get("shell_command")).toBe("bash");
      expect(reverseMap.get("read_file")).toBe("file_read");
      expect(reverseMap.get("write_file")).toBe("file_write");
      expect(reverseMap.get("apply_patch")).toBe("file_edit");
      expect(reverseMap.size).toBe(4);
    });

    it("renames tools for Google models", () => {
      const tools = mockTools();
      const { adaptedTools, reverseMap } = adaptToolsForModel(
        tools,
        mockModel("google"),
      );

      expect(adaptedTools).toHaveProperty("run_shell_command");
      expect(adaptedTools).toHaveProperty("write_file");
      expect(adaptedTools).toHaveProperty("replace");
      // file_read has no Google mapping — passes through
      expect(adaptedTools).toHaveProperty("file_read");

      expect(reverseMap.get("run_shell_command")).toBe("bash");
      expect(reverseMap.get("replace")).toBe("file_edit");
      expect(reverseMap.size).toBe(3);
    });

    it("renames tools for DeepSeek models", () => {
      const { adaptedTools, reverseMap } = adaptToolsForModel(
        mockTools(),
        mockModel("deepseek"),
      );

      expect(adaptedTools).toHaveProperty("shell_command");
      expect(adaptedTools).toHaveProperty("read_file");
      expect(adaptedTools).toHaveProperty("write_file");
      // file_edit has no DeepSeek mapping — passes through
      expect(adaptedTools).toHaveProperty("file_edit");
      expect(reverseMap.size).toBe(3);
    });

    it("preserves execute functions after rename", async () => {
      const tools = mockTools();
      const { adaptedTools } = adaptToolsForModel(tools, mockModel("openai"));

      const result = await adaptedTools.shell_command.execute();
      expect(result).toBe("ok");
    });

    it("handles unknown providers gracefully", () => {
      const tools = mockTools();
      const { adaptedTools, reverseMap } = adaptToolsForModel(
        tools,
        mockModel("unknown-provider"),
      );
      expect(adaptedTools).toBe(tools);
      expect(reverseMap.size).toBe(0);
    });
  });

  describe("resolveCanonicalName", () => {
    it("maps provider-specific name back to canonical", () => {
      const reverseMap = new Map([
        ["shell_command", "bash"],
        ["read_file", "file_read"],
      ]);

      expect(resolveCanonicalName("shell_command", reverseMap)).toBe("bash");
      expect(resolveCanonicalName("read_file", reverseMap)).toBe("file_read");
    });

    it("returns original name when no mapping exists", () => {
      const reverseMap = new Map<string, string>();
      expect(resolveCanonicalName("glob", reverseMap)).toBe("glob");
    });
  });

  describe("getProviderFamily", () => {
    it("extracts provider from slash-separated strings", () => {
      expect(getProviderFamily("openai/gpt-5.4")).toBe("openai");
      expect(getProviderFamily("google/gemini-3.1-pro")).toBe("google");
    });

    it("handles plain provider names", () => {
      expect(getProviderFamily("anthropic")).toBe("anthropic");
      expect(getProviderFamily("deepseek")).toBe("deepseek");
    });

    it("normalizes to lowercase", () => {
      expect(getProviderFamily("OpenAI")).toBe("openai");
    });
  });
});
