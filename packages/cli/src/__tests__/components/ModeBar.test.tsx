/**
 * ModeBar component tests — mode tabs + status display.
 *
 * Tests correct mode highlighting, model/cost/role display,
 * and color thresholds.
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { ModeBar } from "../../components/ModeBar.js";
import { plain, containsText, hasColor, hasBold } from "../helpers/ansi.js";

describe("ModeBar", () => {
  // ── Mode tabs ──────────────────────────────────────────────────────

  it("renders all 4 mode labels", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" />);
    const frame = plain(lastFrame());
    expect(frame).toContain("Chat");
    expect(frame).toContain("Dashboard");
    expect(frame).toContain("Models");
    expect(frame).toContain("Config");
  });

  it("renders mode shortcut keys", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" />);
    const frame = plain(lastFrame());
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    expect(frame).toContain("[3]");
    expect(frame).toContain("[4]");
  });

  it("highlights active mode with bold", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" />);
    expect(hasBold(lastFrame(), "Chat")).toBe(true);
  });

  it("changes active mode when prop changes", () => {
    const { lastFrame, rerender } = render(<ModeBar activeMode="chat" />);
    rerender(<ModeBar activeMode="dashboard" />);
    expect(hasBold(lastFrame(), "Dashboard")).toBe(true);
  });

  // ── Status display ─────────────────────────────────────────────────

  it("shows model name when provided", () => {
    const { lastFrame } = render(
      <ModeBar activeMode="chat" model="Opus 4.6" />,
    );
    expect(containsText(lastFrame(), "Opus 4.6")).toBe(true);
  });

  it("shows cost with 4 decimal places", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" cost={0.0042} />);
    expect(containsText(lastFrame(), "$0.0042")).toBe(true);
  });

  it("shows $0.0000 when cost is zero", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" cost={0} />);
    expect(containsText(lastFrame(), "$0.0000")).toBe(true);
  });

  it("shows cost in green when under threshold", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" cost={0.005} />);
    expect(hasColor(lastFrame(), "$0.0050", "green")).toBe(true);
  });

  it("shows cost in yellow when over $0.01", () => {
    const { lastFrame } = render(<ModeBar activeMode="chat" cost={0.02} />);
    expect(hasColor(lastFrame(), "$0.0200", "yellow")).toBe(true);
  });

  it("shows role when provided", () => {
    const { lastFrame } = render(
      <ModeBar activeMode="chat" role="architect" />,
    );
    expect(containsText(lastFrame(), "architect")).toBe(true);
    expect(hasColor(lastFrame(), "architect", "magenta")).toBe(true);
  });

  it("shows separator between elements", () => {
    const { lastFrame } = render(
      <ModeBar activeMode="chat" model="GPT-5" role="qa" cost={0.001} />,
    );
    expect(containsText(lastFrame(), "│")).toBe(true);
  });

  // ── Guardian status ────────────────────────────────────────────────

  it("shows green dot for safe guardian status", () => {
    const { lastFrame } = render(
      <ModeBar activeMode="chat" guardianStatus="safe" />,
    );
    expect(lastFrame()).toContain("●");
    expect(hasColor(lastFrame(), "●", "green")).toBe(true);
  });

  it("shows yellow warning for flagged guardian status", () => {
    const { lastFrame } = render(
      <ModeBar activeMode="chat" guardianStatus="flagged" />,
    );
    expect(lastFrame()).toContain("⚠");
    expect(hasColor(lastFrame(), "⚠", "yellow")).toBe(true);
  });

  it("shows red warning for other guardian status", () => {
    const { lastFrame } = render(
      <ModeBar activeMode="chat" guardianStatus="blocked" />,
    );
    expect(lastFrame()).toContain("⚠");
    expect(hasColor(lastFrame(), "⚠", "red")).toBe(true);
  });
});
