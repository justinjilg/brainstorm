import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@brainst0rm/shared";
import { renderFinal, markdownToMrkdwn, truncateForSlack } from "../render.js";

describe("renderFinal", () => {
  it("concatenates text-deltas, collects tool names, and extracts cost", () => {
    const events: AgentEvent[] = [
      { type: "text-delta", delta: "Hello " },
      { type: "tool-call-start", toolName: "file_read", args: { path: "a" } },
      { type: "tool-call-result", toolName: "file_read", result: { ok: true } },
      { type: "text-delta", delta: "world" },
      { type: "tool-call-start", toolName: "grep", args: {} },
      { type: "done", totalCost: 0.4213 },
    ];
    const result = renderFinal(events);
    expect(result.markdown).toBe("Hello world");
    expect(result.toolCalls).toEqual(["file_read", "grep"]);
    expect(result.cost).toBe(0.4213);
  });

  it("defaults cost to 0 when there is no done event", () => {
    const result = renderFinal([{ type: "text-delta", delta: "hi" }]);
    expect(result).toEqual({ markdown: "hi", toolCalls: [], cost: 0 });
  });

  it("returns empty result for an empty stream", () => {
    expect(renderFinal([])).toEqual({ markdown: "", toolCalls: [], cost: 0 });
  });
});

describe("markdownToMrkdwn", () => {
  it("converts **bold** to *bold*", () => {
    expect(markdownToMrkdwn("this is **bold** text")).toBe(
      "this is *bold* text",
    );
  });

  it("converts [text](url) to <url|text>", () => {
    expect(markdownToMrkdwn("see [the docs](https://x.io/d)")).toBe(
      "see <https://x.io/d|the docs>",
    );
  });

  it("strips heading #'s to bold lines", () => {
    expect(markdownToMrkdwn("# Title\nbody")).toBe("*Title*\nbody");
    expect(markdownToMrkdwn("### Deep heading")).toBe("*Deep heading*");
  });

  it("collapses a bolded heading to a single-asterisk bold line", () => {
    expect(markdownToMrkdwn("# **Title**")).toBe("*Title*");
    expect(markdownToMrkdwn("## **Big** deal")).toBe("*Big deal*");
  });

  it("preserves fenced code blocks verbatim", () => {
    const md = "before\n```\nconst x = **notbold**;\n# nothead\n```\nafter";
    const out = markdownToMrkdwn(md);
    expect(out).toContain("```\nconst x = **notbold**;\n# nothead\n```");
    expect(out.startsWith("before")).toBe(true);
    expect(out.endsWith("after")).toBe(true);
  });

  it("preserves inline code verbatim", () => {
    expect(markdownToMrkdwn("run `npm **install**` now")).toBe(
      "run `npm **install**` now",
    );
  });

  it("transforms prose around code spans", () => {
    const out = markdownToMrkdwn("**bold** and `code` and **more**");
    expect(out).toBe("*bold* and `code` and *more*");
  });
});

describe("truncateForSlack", () => {
  it("leaves text under the limit unchanged", () => {
    expect(truncateForSlack("short", 100)).toBe("short");
  });

  it("appends a truncation marker when over the limit", () => {
    const out = truncateForSlack("a".repeat(30), 20);
    expect(out.endsWith("… (truncated)")).toBe(true);
    // Total stays within the ceiling so Slack accepts it.
    expect(out.length).toBe(20);
  });

  it("defaults to a ~39k ceiling", () => {
    const big = "x".repeat(40000);
    const out = truncateForSlack(big);
    expect(out.length).toBe(39000);
    expect(out.endsWith("… (truncated)")).toBe(true);
  });
});
