import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

describe("vscode package exports", () => {
  it("exports activate and deactivate from extension.ts", async () => {
    const extension = await import("../extension.js");

    expect(extension.activate).toBeTypeOf("function");
    expect(extension.deactivate).toBeTypeOf("function");
  });

  it("exports BrainstormChatProvider from chat-provider.ts", async () => {
    const chatProvider = await import("../chat-provider.js");

    expect(chatProvider.BrainstormChatProvider).toBeTypeOf("function");
  });

  it("exports StormProcess class and StormEvent interface shape from storm-process.ts", async () => {
    const stormProcess = await import("../storm-process.js");

    expect(stormProcess.StormProcess).toBeTypeOf("function");

    const event: import("../storm-process.js").StormEvent = {
      type: "text",
      data: "ok",
    };

    expect(event.type).toBe("text");
    expect(event.data).toBe("ok");
  });
});
