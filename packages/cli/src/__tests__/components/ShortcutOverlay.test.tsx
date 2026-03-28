/**
 * ShortcutOverlay component tests — keyboard reference overlay.
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { ShortcutOverlay } from "../../components/ShortcutOverlay.js";
import { KEYS, press } from "../helpers/keys.js";
import { containsText } from "../helpers/ansi.js";

describe("ShortcutOverlay", () => {
  it("renders title", () => {
    const { lastFrame } = render(<ShortcutOverlay onDismiss={vi.fn()} />);
    expect(containsText(lastFrame(), "Keyboard Shortcuts")).toBe(true);
  });

  it("shows navigation section", () => {
    const { lastFrame } = render(<ShortcutOverlay onDismiss={vi.fn()} />);
    expect(containsText(lastFrame(), "Navigation")).toBe(true);
    expect(containsText(lastFrame(), "Esc")).toBe(true);
    expect(containsText(lastFrame(), "1-4")).toBe(true);
  });

  it("shows chat mode section", () => {
    const { lastFrame } = render(<ShortcutOverlay onDismiss={vi.fn()} />);
    expect(containsText(lastFrame(), "Chat Mode")).toBe(true);
    expect(containsText(lastFrame(), "Enter")).toBe(true);
    expect(containsText(lastFrame(), "Shift+Tab")).toBe(true);
  });

  it("shows models mode section", () => {
    const { lastFrame } = render(<ShortcutOverlay onDismiss={vi.fn()} />);
    expect(containsText(lastFrame(), "Models Mode")).toBe(true);
    expect(containsText(lastFrame(), "j/k")).toBe(true);
  });

  it("shows key commands section", () => {
    const { lastFrame } = render(<ShortcutOverlay onDismiss={vi.fn()} />);
    expect(containsText(lastFrame(), "/help")).toBe(true);
    expect(containsText(lastFrame(), "/build")).toBe(true);
    expect(containsText(lastFrame(), "/undo")).toBe(true);
  });

  it("shows dismiss instruction", () => {
    const { lastFrame } = render(<ShortcutOverlay onDismiss={vi.fn()} />);
    expect(containsText(lastFrame(), "Press any key")).toBe(true);
  });

  it("calls onDismiss on any key press", async () => {
    const onDismiss = vi.fn();
    const { stdin } = render(<ShortcutOverlay onDismiss={onDismiss} />);
    await press(stdin, "a");
    expect(onDismiss).toHaveBeenCalled();
  });
});
