/**
 * Autocomplete component tests — filtered dropdown for slash commands.
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { Autocomplete } from "../../components/Autocomplete.js";
import { KEYS, press } from "../helpers/keys.js";
import { plain, containsText } from "../helpers/ansi.js";

const ITEMS = [
  { label: "help", description: "Show help" },
  { label: "history", description: "Show history" },
  { label: "models", description: "List models" },
  { label: "build", description: "Build wizard" },
  { label: "compact", description: "Compact context" },
];

function renderAC(query = "", overrides?: Record<string, any>) {
  const onAccept = vi.fn();
  const onDismiss = vi.fn();
  const result = render(
    <Autocomplete
      query={query}
      items={ITEMS}
      onAccept={onAccept}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { ...result, onAccept, onDismiss };
}

describe("Autocomplete", () => {
  it("renders all items when query is empty", () => {
    const { lastFrame } = renderAC("");
    const frame = plain(lastFrame());
    expect(frame).toContain("help");
    expect(frame).toContain("models");
    expect(frame).toContain("build");
  });

  it("filters items by query (case-insensitive)", () => {
    const { lastFrame } = renderAC("hel");
    const frame = plain(lastFrame());
    expect(frame).toContain("help");
    expect(frame).not.toContain("models");
    expect(frame).not.toContain("build");
  });

  it("shows descriptions", () => {
    const { lastFrame } = renderAC("");
    expect(containsText(lastFrame(), "Show help")).toBe(true);
  });

  it("returns null when no items match", () => {
    const { lastFrame } = renderAC("xyz");
    expect(lastFrame()).toBe("");
  });

  it("respects maxVisible limit", () => {
    const { lastFrame } = renderAC("", { maxVisible: 2 });
    const frame = plain(lastFrame());
    const matches = ITEMS.filter((i) => frame.includes(i.label));
    expect(matches.length).toBe(2);
  });

  it("navigates down with arrow key", async () => {
    const { lastFrame, stdin } = renderAC("");
    await press(stdin, KEYS.DOWN);
    const frame = plain(lastFrame());
    // Second item should now have cursor
    const lines = frame.split("\n").filter((l) => l.includes("▸"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("history");
  });

  it("navigates up with arrow key", async () => {
    const { lastFrame, stdin } = renderAC("");
    await press(stdin, KEYS.DOWN);
    await press(stdin, KEYS.UP);
    const lines = plain(lastFrame())
      .split("\n")
      .filter((l) => l.includes("▸"));
    expect(lines[0]).toContain("help");
  });

  it("accepts with Enter", async () => {
    const { stdin, onAccept } = renderAC("");
    await press(stdin, KEYS.ENTER);
    expect(onAccept).toHaveBeenCalledWith("help");
  });

  it("accepts with Tab", async () => {
    const { stdin, onAccept } = renderAC("");
    await press(stdin, KEYS.TAB);
    expect(onAccept).toHaveBeenCalledWith("help");
  });

  it("accepts correct item after navigation", async () => {
    const { stdin, onAccept } = renderAC("");
    await press(stdin, KEYS.DOWN); // → history
    await press(stdin, KEYS.DOWN); // → models
    await press(stdin, KEYS.ENTER);
    expect(onAccept).toHaveBeenCalledWith("models");
  });

  it("dismisses with Escape", async () => {
    const { stdin, onDismiss } = renderAC("");
    await press(stdin, KEYS.ESCAPE);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("stays at top when pressing Up at index 0", async () => {
    const { stdin, onAccept } = renderAC("");
    await press(stdin, KEYS.UP);
    await press(stdin, KEYS.ENTER);
    expect(onAccept).toHaveBeenCalledWith("help");
  });
});
