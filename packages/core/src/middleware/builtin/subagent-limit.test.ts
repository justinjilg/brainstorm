import { describe, it, expect } from "vitest";
import { subagentLimitMiddleware } from "./subagent-limit.js";
import type { MiddlewareMessage, MiddlewareToolCall } from "../types.js";

describe("subagentLimitMiddleware", () => {
  function createMessage(toolCalls: MiddlewareToolCall[]): MiddlewareMessage {
    return {
      text: "response",
      toolCalls,
      model: "test-model",
      tokens: { input: 100, output: 50 },
    };
  }

  function subagentCall(id: string): MiddlewareToolCall {
    return { id, name: "subagent", input: {} };
  }

  it("truncates more than 3 subagent calls to the first 3, leaving other calls untouched", () => {
    const toolCalls: MiddlewareToolCall[] = [
      subagentCall("s1"),
      { id: "f1", name: "file_read", input: {} },
      subagentCall("s2"),
      subagentCall("s3"),
      subagentCall("s4"),
      subagentCall("s5"),
      { id: "f2", name: "shell", input: {} },
    ];
    const message = createMessage(toolCalls);

    const result = subagentLimitMiddleware.afterModel!(message);

    expect(result).toBeDefined();
    const resultCalls = result!.toolCalls;
    const subagentIds = resultCalls
      .filter((tc) => tc.name === "subagent")
      .map((tc) => tc.id);
    expect(subagentIds).toEqual(["s1", "s2", "s3"]);

    // non-subagent calls untouched
    expect(resultCalls.some((tc) => tc.id === "f1")).toBe(true);
    expect(resultCalls.some((tc) => tc.id === "f2")).toBe(true);
    expect(resultCalls.length).toBe(5);
  });

  it("leaves message unchanged (returns undefined) when 3 or fewer subagent calls", () => {
    const toolCalls: MiddlewareToolCall[] = [
      subagentCall("s1"),
      subagentCall("s2"),
    ];
    const message = createMessage(toolCalls);

    const result = subagentLimitMiddleware.afterModel!(message);

    expect(result).toBeUndefined();
  });

  it("counts legacy tool names (spawn_subagent, spawn_parallel) toward the limit", () => {
    const toolCalls: MiddlewareToolCall[] = [
      { id: "s1", name: "spawn_subagent", input: {} },
      { id: "s2", name: "spawn_parallel", input: {} },
      subagentCall("s3"),
      subagentCall("s4"),
      subagentCall("s5"),
    ];
    const message = createMessage(toolCalls);

    const result = subagentLimitMiddleware.afterModel!(message);

    expect(result).toBeDefined();
    const resultIds = result!.toolCalls.map((tc) => tc.id);
    expect(resultIds).toEqual(["s1", "s2", "s3"]);
  });
});
