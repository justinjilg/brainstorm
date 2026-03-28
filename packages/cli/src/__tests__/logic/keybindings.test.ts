/**
 * Keybinding resolution tests — pure function tests for key → action mapping.
 */

import { describe, it, expect } from "vitest";
import {
  resolveKeyAction,
  formatKeybindings,
  DEFAULT_KEYBINDINGS,
  type KeyEvent,
} from "../../keybindings.js";

/** Create a default (all-false) key event, with overrides. */
function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

describe("resolveKeyAction", () => {
  it("maps Escape to abort", () => {
    expect(resolveKeyAction("", key({ escape: true }))).toBe("abort");
  });

  it("maps Ctrl+D to exit", () => {
    expect(resolveKeyAction("d", key({ ctrl: true }))).toBe("exit");
  });

  it("maps Ctrl+empty to exit (stdin EOF)", () => {
    expect(resolveKeyAction("", key({ ctrl: true }))).toBe("exit");
  });

  it("maps Ctrl+L to clear-screen", () => {
    expect(resolveKeyAction("l", key({ ctrl: true }))).toBe("clear-screen");
  });

  it("maps Ctrl+form-feed to clear-screen", () => {
    expect(resolveKeyAction("\f", key({ ctrl: true }))).toBe("clear-screen");
  });

  it("maps Ctrl+K to clear-chat", () => {
    expect(resolveKeyAction("k", key({ ctrl: true }))).toBe("clear-chat");
  });

  it("maps Ctrl+VT to clear-chat", () => {
    expect(resolveKeyAction("\x0b", key({ ctrl: true }))).toBe("clear-chat");
  });

  it("maps Shift+Tab to cycle-mode", () => {
    expect(resolveKeyAction("", key({ shift: true, tab: true }))).toBe(
      "cycle-mode",
    );
  });

  it("returns null for unbound regular keys", () => {
    expect(resolveKeyAction("a", key())).toBeNull();
    expect(resolveKeyAction("z", key())).toBeNull();
    expect(resolveKeyAction("1", key())).toBeNull();
  });

  it("returns null for unbound special keys", () => {
    expect(resolveKeyAction("", key({ upArrow: true }))).toBeNull();
    expect(resolveKeyAction("", key({ downArrow: true }))).toBeNull();
    expect(resolveKeyAction("", key({ return: true }))).toBeNull();
    expect(resolveKeyAction("", key({ tab: true }))).toBeNull();
  });

  it("returns null for Ctrl+other letters", () => {
    expect(resolveKeyAction("a", key({ ctrl: true }))).toBeNull();
    expect(resolveKeyAction("z", key({ ctrl: true }))).toBeNull();
  });

  it("first matching binding wins", () => {
    // Escape matches 'abort' before anything else
    const result = resolveKeyAction("", key({ escape: true }));
    expect(result).toBe("abort");
  });

  it("accepts custom bindings", () => {
    const custom = [
      {
        action: "abort" as const,
        description: "Custom abort",
        match: (input: string) => input === "q",
      },
    ];
    expect(resolveKeyAction("q", key(), custom)).toBe("abort");
    expect(resolveKeyAction("x", key(), custom)).toBeNull();
  });
});

describe("formatKeybindings", () => {
  it("includes all default bindings", () => {
    const text = formatKeybindings();
    expect(text).toContain("Escape");
    expect(text).toContain("Ctrl+D");
    expect(text).toContain("Ctrl+L");
    expect(text).toContain("Ctrl+K");
    expect(text).toContain("Shift+Tab");
  });

  it("includes descriptions", () => {
    const text = formatKeybindings();
    expect(text).toContain("Interrupt");
    expect(text).toContain("Exit");
    expect(text).toContain("Clear terminal");
    expect(text).toContain("Clear conversation");
    expect(text).toContain("Cycle permission");
  });

  it("formats as aligned columns", () => {
    const lines = formatKeybindings().split("\n");
    expect(lines.length).toBe(DEFAULT_KEYBINDINGS.length);
    // Each line should start with spaces (indentation)
    for (const line of lines) {
      expect(line).toMatch(/^\s+\S/);
    }
  });
});
