/**
 * KeyHint component tests — verifies footer hints per mode.
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { KeyHint } from "../../components/KeyHint.js";
import { plain, containsText } from "../helpers/ansi.js";

describe("KeyHint", () => {
  it("shows chat hints in chat mode", () => {
    const { lastFrame } = render(<KeyHint mode="chat" />);
    const frame = lastFrame();
    expect(containsText(frame, "Esc dashboard")).toBe(true);
    expect(containsText(frame, "Ctrl+D")).toBe(true);
  });

  it("shows dashboard hints in dashboard mode", () => {
    const { lastFrame } = render(<KeyHint mode="dashboard" />);
    expect(containsText(lastFrame(), "1-4 switch")).toBe(true);
    expect(containsText(lastFrame(), "r refresh")).toBe(true);
  });

  it("shows models hints in models mode", () => {
    const { lastFrame } = render(<KeyHint mode="models" />);
    expect(containsText(lastFrame(), "navigate")).toBe(true);
    expect(containsText(lastFrame(), "Enter select")).toBe(true);
  });

  it("shows config hints in config mode", () => {
    const { lastFrame } = render(<KeyHint mode="config" />);
    expect(containsText(lastFrame(), "Esc chat")).toBe(true);
  });

  it("shows processing hints when processing", () => {
    const { lastFrame } = render(<KeyHint mode="chat" isProcessing />);
    expect(containsText(lastFrame(), "Esc abort")).toBe(true);
    expect(containsText(lastFrame(), "scroll")).toBe(true);
  });
});
