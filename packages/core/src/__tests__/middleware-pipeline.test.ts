import { describe, it, expect } from "vitest";
import { MiddlewarePipeline } from "../middleware/pipeline";
import type {
  AgentMiddleware,
  MiddlewareState,
  MiddlewareMessage,
  MiddlewareToolCall,
  MiddlewareToolResult,
} from "../middleware/types";

describe("MiddlewarePipeline", () => {
  function createState(
    overrides: Partial<MiddlewareState> = {},
  ): MiddlewareState {
    return {
      turn: 1,
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are a test assistant.",
      toolNames: ["file_read", "shell"],
      metadata: {},
      ...overrides,
    };
  }

  function createMessage(
    overrides: Partial<MiddlewareMessage> = {},
  ): MiddlewareMessage {
    return {
      text: "I'll help you with that.",
      toolCalls: [],
      model: "test-model",
      tokens: { input: 100, output: 50 },
      ...overrides,
    };
  }

  it("runs beforeAgent middleware in order", () => {
    const pipeline = new MiddlewarePipeline();
    const order: string[] = [];

    pipeline.use({
      name: "first",
      beforeAgent(state) {
        order.push("first");
        return { ...state, metadata: { ...state.metadata, first: true } };
      },
    });

    pipeline.use({
      name: "second",
      beforeAgent(state) {
        order.push("second");
        return { ...state, metadata: { ...state.metadata, second: true } };
      },
    });

    const state = createState();
    const result = pipeline.runBeforeAgent(state);

    expect(order).toEqual(["first", "second"]);
    expect(result.metadata).toEqual({ first: true, second: true });
  });

  it("afterModel middleware can modify message", () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use({
      name: "truncator",
      afterModel(message) {
        return { ...message, text: message.text.slice(0, 10) };
      },
    });

    const message = createMessage({
      text: "This is a long response that should be truncated",
    });
    const result = pipeline.runAfterModel(message);

    expect(result.text).toBe("This is a ");
  });

  it("wrapToolCall can block a tool call", () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use({
      name: "blocker",
      wrapToolCall(call) {
        if (call.name === "shell") {
          return {
            blocked: true,
            reason: "Shell blocked",
            middleware: "blocker",
          };
        }
      },
    });

    const shellCall: MiddlewareToolCall = {
      id: "1",
      name: "shell",
      input: { command: "rm -rf /" },
    };
    const readCall: MiddlewareToolCall = {
      id: "2",
      name: "file_read",
      input: { path: "/a.ts" },
    };

    const shellResult = pipeline.runWrapToolCall(shellCall);
    const readResult = pipeline.runWrapToolCall(readCall);

    expect(shellResult).toHaveProperty("blocked", true);
    expect(readResult).not.toHaveProperty("blocked");
  });

  it("afterToolResult middleware can modify results", () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use({
      name: "timer",
      afterToolResult(result) {
        return { ...result, durationMs: result.durationMs + 100 };
      },
    });

    const toolResult: MiddlewareToolResult = {
      toolCallId: "1",
      name: "file_read",
      ok: true,
      output: "file contents",
      durationMs: 50,
    };

    const result = pipeline.runAfterToolResult(toolResult);
    expect(result.durationMs).toBe(150);
  });

  it("middleware that returns void passes through unchanged", () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use({
      name: "noop",
      afterModel() {
        // returns void
      },
    });

    const message = createMessage({ text: "original" });
    const result = pipeline.runAfterModel(message);

    expect(result.text).toBe("original");
  });

  it("list returns registered middleware names", () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.use({ name: "alpha" });
    pipeline.use({ name: "beta" });

    expect(pipeline.list()).toEqual(["alpha", "beta"]);
  });

  it("remove removes middleware by name", () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.use({ name: "alpha" });
    pipeline.use({ name: "beta" });
    pipeline.remove("alpha");

    expect(pipeline.list()).toEqual(["beta"]);
  });
});

describe("Memory Extraction Middleware", () => {
  it("extracts user preferences from response text", async () => {
    // Import dynamically to avoid circular dep issues in test
    const { createMemoryExtractionMiddleware } =
      await import("../middleware/builtin/memory-extract");

    const middleware = createMemoryExtractionMiddleware("/tmp/test-project");
    const message = createMessage({
      text: "I always use tabs for indentation in this project.",
    });

    // Should not throw — side effect is saving to MemoryManager
    expect(() => middleware.afterModel?.(message)).not.toThrow();
  });

  function createMessage(
    overrides: Partial<MiddlewareMessage> = {},
  ): MiddlewareMessage {
    return {
      text: "",
      toolCalls: [],
      model: "test-model",
      tokens: { input: 100, output: 50 },
      ...overrides,
    };
  }
});

describe("Proactive Compaction Middleware", () => {
  it("injects warning at 60% context usage", async () => {
    const { createProactiveCompactionMiddleware } =
      await import("../middleware/builtin/proactive-compaction");

    // 128K context window, ~4 chars/token → need ~307K chars for 60%
    const longContent = "A".repeat(320_000);
    const middleware = createProactiveCompactionMiddleware(128_000);

    const state: MiddlewareState = {
      turn: 1,
      messages: [{ role: "user", content: longContent }],
      systemPrompt: "test",
      toolNames: [],
      metadata: {},
    };

    const result = middleware.beforeAgent?.(state);
    expect(result?.systemPrompt).toContain("CONTEXT NOTE");
  });

  it("does not inject at low usage", async () => {
    const { createProactiveCompactionMiddleware } =
      await import("../middleware/builtin/proactive-compaction");

    const middleware = createProactiveCompactionMiddleware(128_000);

    const state: MiddlewareState = {
      turn: 1,
      messages: [{ role: "user", content: "short message" }],
      systemPrompt: "test",
      toolNames: [],
      metadata: {},
    };

    const result = middleware.beforeAgent?.(state);
    expect(result).toBeUndefined();
  });
});
