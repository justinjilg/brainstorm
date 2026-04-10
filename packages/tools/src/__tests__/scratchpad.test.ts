import { describe, it, expect, beforeEach } from "vitest";
import {
  scratchpadWriteTool,
  scratchpadReadTool,
  clearScratchpad,
  formatScratchpadContext,
} from "../builtin/scratchpad.js";

describe("scratchpad tools", () => {
  beforeEach(() => {
    clearScratchpad();
  });

  it("should write a note to the scratchpad", async () => {
    const result = await scratchpadWriteTool.execute({
      key: "test_note",
      value: "This is a test note",
    });

    expect(result).toMatchObject({
      success: true,
      key: "test_note",
      totalNotes: 1,
    });
  });

  it("should read a specific note", async () => {
    await scratchpadWriteTool.execute({
      key: "config",
      value: "enabled=true",
    });

    const result = await scratchpadReadTool.execute({
      key: "config",
    });

    expect(result).toMatchObject({
      key: "config",
      value: "enabled=true",
    });
  });

  it("should read all notes if no key provided", async () => {
    await scratchpadWriteTool.execute({ key: "a", value: "1" });
    await scratchpadWriteTool.execute({ key: "b", value: "2" });

    const result = await scratchpadReadTool.execute({});

    expect(result).toHaveProperty("notes");
    expect((result as any).notes).toMatchObject({
      a: "1",
      b: "2",
    });
  });

  it("should return an error for a non-existent note", async () => {
    const result = await scratchpadReadTool.execute({
      key: "missing",
    });

    expect(result).toHaveProperty("error");
    expect((result as any).error).toContain("not found");
  });

  it("should format scratchpad context correctly", async () => {
    expect(formatScratchpadContext()).toBe("");

    await scratchpadWriteTool.execute({ key: "theme", value: "dark" });
    await scratchpadWriteTool.execute({ key: "lang", value: "typescript" });

    const formatted = formatScratchpadContext();
    expect(formatted).toContain("[Scratchpad — preserved through compaction]");
    expect(formatted).toContain("- theme: dark");
    expect(formatted).toContain("- lang: typescript");
  });
});
