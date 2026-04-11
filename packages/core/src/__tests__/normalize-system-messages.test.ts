import { describe, expect, it } from "vitest";
import { normalizeSystemMessagesForProvider } from "../agent/loop.js";

describe("normalizeSystemMessagesForProvider", () => {
  it("passes through unchanged when there are no system messages in history", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const { systemForApiNormalized, messagesForApi } =
      normalizeSystemMessagesForProvider("you are helpful", messages);

    expect(systemForApiNormalized).toBe("you are helpful");
    expect(messagesForApi).toBe(messages); // referential equality — fast path
  });

  it("extracts a single mid-conversation system message into the system field", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "[Compaction summary] 12 messages condensed" },
      { role: "user", content: "continue" },
    ];
    const { systemForApiNormalized, messagesForApi } =
      normalizeSystemMessagesForProvider("you are helpful", messages);

    expect(messagesForApi).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "continue" },
    ]);

    // String input becomes an array with the original prompt + extracted segments
    expect(Array.isArray(systemForApiNormalized)).toBe(true);
    expect(systemForApiNormalized).toEqual([
      { role: "system", content: "you are helpful" },
      {
        role: "system",
        content: "[Compaction summary] 12 messages condensed",
      },
    ]);
  });

  it("preserves order when extracting multiple system messages", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "system", content: "first compaction" },
      { role: "user", content: "second" },
      { role: "system", content: "second compaction" },
      { role: "system", content: "scratchpad" },
      { role: "user", content: "third" },
    ];
    const { systemForApiNormalized, messagesForApi } =
      normalizeSystemMessagesForProvider("base", messages);

    expect(messagesForApi).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ]);
    expect(systemForApiNormalized).toEqual([
      { role: "system", content: "base" },
      { role: "system", content: "first compaction" },
      { role: "system", content: "second compaction" },
      { role: "system", content: "scratchpad" },
    ]);
  });

  it("preserves cache hints on existing system segments when input is an array", () => {
    const systemArray = [
      {
        role: "system" as const,
        content: "stable prefix",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    ];
    const messages = [
      { role: "user", content: "hi" },
      { role: "system", content: "compaction summary" },
    ];
    const { systemForApiNormalized, messagesForApi } =
      normalizeSystemMessagesForProvider(systemArray, messages);

    expect(messagesForApi).toEqual([{ role: "user", content: "hi" }]);
    expect(systemForApiNormalized).toEqual([
      {
        role: "system",
        content: "stable prefix",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      { role: "system", content: "compaction summary" },
    ]);
  });

  it("handles non-string content by stringifying it", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "system", content: { foo: "bar" } as unknown as string },
    ];
    const { messagesForApi, systemForApiNormalized } =
      normalizeSystemMessagesForProvider("base", messages);

    expect(messagesForApi).toEqual([{ role: "user", content: "hi" }]);
    expect(Array.isArray(systemForApiNormalized)).toBe(true);
    const arr = systemForApiNormalized as Array<{
      role: "system";
      content: string;
    }>;
    expect(arr[1].content).toBe("[object Object]");
  });
});
