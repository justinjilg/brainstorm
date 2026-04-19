/**
 * Content injection filter middleware — output-swap correctness trap.
 *
 * The middleware extracts content from `output.content`, `output.text`,
 * OR `output.body`, sanitizes it, then swaps the sanitized version
 * back in. Pre-fix, the swap only covered `content` and `text`.
 * A tool output shape with ONLY `body` had its metadata flagged as
 * sanitized but the model still saw the original unsanitized body —
 * a silent security defect: the filter said "I sanitized this"
 * without actually doing so.
 *
 * Real tool that hits this shape: HTTP clients that return
 * `{ status, headers, body }`. The web tools mostly use `content`,
 * but custom MCP web fetchers may return `body`.
 */

import { describe, it, expect } from "vitest";
import { createContentInjectionFilterMiddleware } from "../middleware/builtin/content-injection-filter.js";
import type { MiddlewareToolResult } from "../middleware/types.js";

const middleware = createContentInjectionFilterMiddleware();

// Dangerous content that the sanitizer WILL modify (HTML script tag
// triggers the strip path, which sets `sanitized.modified = true`).
const DANGEROUS_CONTENT =
  '<script>alert("pwn")</script>Legitimate text afterward.';

function makeResult(output: unknown): MiddlewareToolResult {
  return {
    toolCallId: "call-test",
    name: "web_fetch",
    ok: true,
    output,
    durationMs: 0,
  };
}

describe("content-injection-filter — output swap", () => {
  it("swaps sanitized content back into `output.content`", () => {
    const result = middleware.afterToolResult!(
      makeResult({ content: DANGEROUS_CONTENT }),
    );
    expect(result).toBeDefined();
    // `output.content` must no longer contain the <script> tag.
    const out = result!.output as Record<string, unknown>;
    expect(out.content).not.toContain("<script>");
    expect(out._sanitized).toBe(true);
  });

  it("swaps sanitized content back into `output.text`", () => {
    const result = middleware.afterToolResult!(
      makeResult({ text: DANGEROUS_CONTENT }),
    );
    expect(result).toBeDefined();
    const out = result!.output as Record<string, unknown>;
    expect(out.text).not.toContain("<script>");
    expect(out._sanitized).toBe(true);
  });

  it("swaps sanitized content back into `output.body` (was silent-fail pre-fix)", () => {
    // Pre-fix: metadata._sanitized=true but output.body still
    // contained <script>. The model saw the original.
    const result = middleware.afterToolResult!(
      makeResult({ body: DANGEROUS_CONTENT }),
    );
    expect(result).toBeDefined();
    const out = result!.output as Record<string, unknown>;
    expect(
      out.body,
      "sanitized content must replace body; otherwise the model sees the dangerous source while metadata falsely claims it was cleaned",
    ).not.toContain("<script>");
    expect(out._sanitized).toBe(true);
  });

  it("leaves non-web-tool outputs alone", () => {
    const result = middleware.afterToolResult!({
      toolCallId: "call-shell",
      name: "shell",
      ok: true,
      output: { content: DANGEROUS_CONTENT },
      durationMs: 0,
    });
    // Returning undefined means "no change" — web-tool-only filter.
    expect(result).toBeUndefined();
  });

  it("leaves failed tool results alone", () => {
    const result = middleware.afterToolResult!({
      toolCallId: "call-fail",
      name: "web_fetch",
      ok: false,
      output: { error: "network error" },
      durationMs: 0,
    });
    expect(result).toBeUndefined();
  });
});
