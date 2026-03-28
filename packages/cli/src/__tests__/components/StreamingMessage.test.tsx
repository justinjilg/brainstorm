/**
 * StreamingMessage component tests — streaming render + truncation.
 *
 * Verifies the fix for the screen-freeze bug (long content truncation).
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { StreamingMessage } from "../../components/StreamingMessage.js";
import { plain, containsText, hasBold } from "../helpers/ansi.js";

describe("StreamingMessage", () => {
  // ── No content + streaming: spinner ────────────────────────────────

  it("shows spinner when streaming with no content", () => {
    const { lastFrame } = render(
      <StreamingMessage content="" isStreaming phase="routing" />,
    );
    const frame = plain(lastFrame());
    expect(frame).toContain("Selecting model");
  });

  it("shows model name in spinner", () => {
    const { lastFrame } = render(
      <StreamingMessage
        content=""
        isStreaming
        phase="streaming"
        model="Opus 4.6"
      />,
    );
    expect(containsText(lastFrame(), "Opus 4.6")).toBe(true);
  });

  it("shows 'Thinking' as default phase label", () => {
    const { lastFrame } = render(<StreamingMessage content="" isStreaming />);
    expect(containsText(lastFrame(), "Thinking")).toBe(true);
  });

  it("maps known phases to labels", () => {
    const phases = [
      ["classifying", "Analyzing"],
      ["routing", "Selecting model"],
      ["connecting", "Connecting"],
      ["streaming", "Streaming"],
    ];
    for (const [phase, label] of phases) {
      const { lastFrame, unmount } = render(
        <StreamingMessage content="" isStreaming phase={phase} />,
      );
      expect(containsText(lastFrame(), label)).toBe(true);
      unmount();
    }
  });

  // ── Content + streaming: cursor ────────────────────────────────────

  it("shows cursor character when streaming with content", () => {
    const { lastFrame } = render(
      <StreamingMessage content="Hello world" isStreaming />,
    );
    expect(lastFrame()).toContain("▌");
  });

  it("shows 'brainstorm' label when streaming content", () => {
    const { lastFrame } = render(
      <StreamingMessage content="Hello" isStreaming />,
    );
    expect(containsText(lastFrame(), "brainstorm")).toBe(true);
  });

  it("shows model name bracket when streaming content", () => {
    const { lastFrame } = render(
      <StreamingMessage content="Hello" isStreaming model="GPT-5" />,
    );
    expect(containsText(lastFrame(), "[GPT-5]")).toBe(true);
  });

  // ── Truncation (freeze prevention) ────────────────────────────────

  it("truncates content over 2000 chars", () => {
    const longContent = "X".repeat(5000);
    const { lastFrame } = render(
      <StreamingMessage content={longContent} isStreaming />,
    );
    const frame = plain(lastFrame());
    // Should show truncation indicator
    expect(frame).toContain("5000 chars");
    expect(frame).toContain("showing tail");
  });

  it("does not truncate content under 2000 chars", () => {
    const shortContent = "Hello world";
    const { lastFrame } = render(
      <StreamingMessage content={shortContent} isStreaming />,
    );
    const frame = plain(lastFrame());
    expect(frame).not.toContain("showing tail");
  });

  // ── Not streaming: null ────────────────────────────────────────────

  it("returns null when not streaming and no content", () => {
    const { lastFrame } = render(
      <StreamingMessage content="" isStreaming={false} />,
    );
    expect(lastFrame()).toBe("");
  });

  it("returns null when not streaming even with content", () => {
    const { lastFrame } = render(
      <StreamingMessage content="Done" isStreaming={false} />,
    );
    // StreamingMessage returns null when not streaming — content
    // should be rendered by MessageList instead
    expect(lastFrame()).toBe("");
  });
});
