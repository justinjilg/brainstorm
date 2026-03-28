/**
 * SelectPrompt component tests — interactive keyboard selection.
 *
 * Tests arrow navigation, Enter/Escape handling, multi-select,
 * and visual indicators (cursor, recommended, descriptions).
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { SelectPrompt } from "../../components/SelectPrompt.js";
import { KEYS, press } from "../helpers/keys.js";
import { plain, containsText } from "../helpers/ansi.js";
import { makeSelectOptions } from "../helpers/factories.js";

function renderPrompt(overrides?: Record<string, any>) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const onMultiSelect = vi.fn();
  const options = makeSelectOptions(3);

  const result = render(
    <SelectPrompt
      message="Pick something"
      options={options}
      onSelect={onSelect}
      onCancel={onCancel}
      {...overrides}
    />,
  );

  return { ...result, onSelect, onCancel, onMultiSelect, options };
}

describe("SelectPrompt", () => {
  // ── Rendering ──────────────────────────────────────────────────────

  it("renders the message", () => {
    const { lastFrame } = renderPrompt();
    expect(containsText(lastFrame(), "Pick something")).toBe(true);
  });

  it("renders all option labels", () => {
    const { lastFrame, options } = renderPrompt();
    const frame = plain(lastFrame());
    for (const opt of options) {
      expect(frame).toContain(opt.label);
    }
  });

  it("shows cursor indicator on first option by default", () => {
    const { lastFrame } = renderPrompt();
    const lines = plain(lastFrame()).split("\n");
    const firstOptionLine = lines.find((l) => l.includes("Option 1"));
    expect(firstOptionLine).toContain("▸");
  });

  it("shows (recommended) for recommended options", () => {
    const { lastFrame } = renderPrompt();
    expect(containsText(lastFrame(), "(recommended)")).toBe(true);
  });

  it("shows description for cursor item only", () => {
    const { lastFrame } = renderPrompt();
    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 1");
    expect(frame).not.toContain("Description for option 2");
    expect(frame).not.toContain("Description for option 3");
  });

  it("shows navigation hint", () => {
    const { lastFrame } = renderPrompt();
    expect(containsText(lastFrame(), "navigate")).toBe(true);
    expect(containsText(lastFrame(), "Enter select")).toBe(true);
  });

  // ── Navigation ─────────────────────────────────────────────────────

  it("moves cursor down with Down arrow", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, KEYS.DOWN);

    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 2");
    expect(frame).not.toContain("Description for option 1");
  });

  it("moves cursor down with j key", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, "j");

    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 2");
  });

  it("moves cursor up with Up arrow", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, KEYS.DOWN);
    await press(stdin, KEYS.UP);

    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 1");
  });

  it("moves cursor up with k key", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, "j");
    await press(stdin, "k");

    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 1");
  });

  it("stays at top when pressing Up at index 0", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, KEYS.UP);
    await press(stdin, KEYS.UP);

    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 1");
  });

  it("stays at bottom when pressing Down at last index", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, KEYS.DOWN);
    await press(stdin, KEYS.DOWN);
    await press(stdin, KEYS.DOWN); // beyond last

    const frame = plain(lastFrame());
    expect(frame).toContain("Description for option 3");
  });

  // ── Selection ──────────────────────────────────────────────────────

  it("calls onSelect with first option value on Enter", async () => {
    const { stdin, onSelect, options } = renderPrompt();
    await press(stdin, KEYS.ENTER);
    expect(onSelect).toHaveBeenCalledWith(options[0].value);
  });

  it("calls onSelect with second option after Down + Enter", async () => {
    const { stdin, onSelect, options } = renderPrompt();
    await press(stdin, KEYS.DOWN);
    await press(stdin, KEYS.ENTER);
    expect(onSelect).toHaveBeenCalledWith(options[1].value);
  });

  it("calls onCancel on Escape", async () => {
    const { stdin, onCancel } = renderPrompt();
    await press(stdin, KEYS.ESCAPE);
    expect(onCancel).toHaveBeenCalled();
  });

  // ── Multi-select ───────────────────────────────────────────────────

  it("shows toggle hint in multi-select mode", () => {
    const onMultiSelect = vi.fn();
    const { lastFrame } = render(
      <SelectPrompt
        message="Pick many"
        options={makeSelectOptions(3)}
        onSelect={vi.fn()}
        multiSelect
        onMultiSelect={onMultiSelect}
      />,
    );
    expect(containsText(lastFrame(), "Space toggle")).toBe(true);
  });

  it("toggles selection with Space in multi-select mode", async () => {
    const onMultiSelect = vi.fn();
    const options = makeSelectOptions(3);
    const { lastFrame, stdin } = render(
      <SelectPrompt
        message="Pick many"
        options={options}
        onSelect={vi.fn()}
        multiSelect
        onMultiSelect={onMultiSelect}
      />,
    );

    // Initially all unselected (○)
    expect(lastFrame()).toContain("○");

    // Select first option
    await press(stdin, KEYS.SPACE);
    expect(lastFrame()).toContain("◉");

    // Move down and select second
    await press(stdin, KEYS.DOWN);
    await press(stdin, KEYS.SPACE);

    // Confirm with Enter
    await press(stdin, KEYS.ENTER);
    expect(onMultiSelect).toHaveBeenCalledWith([
      options[0].value,
      options[1].value,
    ]);
  });

  it("deselects with Space on already-selected item", async () => {
    const onMultiSelect = vi.fn();
    const options = makeSelectOptions(2);
    const { stdin } = render(
      <SelectPrompt
        message="Pick"
        options={options}
        onSelect={vi.fn()}
        multiSelect
        onMultiSelect={onMultiSelect}
      />,
    );

    await press(stdin, KEYS.SPACE); // select
    await press(stdin, KEYS.SPACE); // deselect
    await press(stdin, KEYS.ENTER);
    expect(onMultiSelect).toHaveBeenCalledWith([]);
  });

  // ── Visual indicators ──────────────────────────────────────────────

  it("shows ▸ cursor on active item", () => {
    const { lastFrame } = renderPrompt();
    expect(lastFrame()).toContain("▸");
  });

  it("cursor moves to second item after Down", async () => {
    const { lastFrame, stdin } = renderPrompt();
    await press(stdin, KEYS.DOWN);
    const lines = plain(lastFrame()).split("\n");
    const opt2Line = lines.find((l) => l.includes("Option 2"));
    expect(opt2Line).toContain("▸");
    const opt1Line = lines.find((l) => l.includes("Option 1"));
    expect(opt1Line).not.toContain("▸");
  });
});
