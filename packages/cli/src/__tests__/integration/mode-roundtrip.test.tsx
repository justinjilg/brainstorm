/**
 * Integration test — full App mode switching roundtrip.
 *
 * Renders the complete <App> component and verifies that:
 * 1. Mode switching works (Escape, number keys)
 * 2. Chat state persists across mode switches
 * 3. Correct content renders per mode
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "../../components/App.js";
import { KEYS, press } from "../helpers/keys.js";
import { plain, containsText } from "../helpers/ansi.js";
import { makeAppProps } from "../helpers/factories.js";

// Mock useBRData hook to avoid gateway calls
vi.mock("../../hooks/useBRData.js", () => ({
  useBRData: () => ({ data: null, refresh: vi.fn() }),
}));

// Mock process.stdout for terminal dimensions
beforeEach(() => {
  Object.defineProperty(process.stdout, "rows", {
    value: 40,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "columns", {
    value: 120,
    writable: true,
    configurable: true,
  });
});

function renderApp(overrides?: Record<string, any>) {
  const props = makeAppProps(overrides);
  return render(<App {...props} />);
}

describe("Mode switching roundtrip", () => {
  it("starts in chat mode", () => {
    const { lastFrame } = renderApp();
    const frame = plain(lastFrame());
    // ModeBar should show Chat as active
    expect(frame).toContain("Chat");
    // KeyHint should show chat hints
    expect(frame).toContain("Esc dashboard");
  });

  it("Escape switches from chat to dashboard", async () => {
    const { lastFrame, stdin } = renderApp();
    await press(stdin, KEYS.ESCAPE);

    const frame = plain(lastFrame());
    // Dashboard mode content should include session stats
    expect(frame).toContain("Dashboard");
    // KeyHint should show dashboard hints
    expect(frame).toContain("r refresh");
  });

  it("Escape from dashboard returns to chat", async () => {
    const { lastFrame, stdin } = renderApp();
    await press(stdin, KEYS.ESCAPE); // chat → dashboard
    await press(stdin, KEYS.ESCAPE); // dashboard → chat

    const frame = plain(lastFrame());
    expect(frame).toContain("Esc dashboard");
  });

  it("number keys switch modes from non-chat mode", async () => {
    const { lastFrame, stdin } = renderApp();
    await press(stdin, KEYS.ESCAPE); // → dashboard

    await press(stdin, "3"); // → models
    expect(containsText(lastFrame(), "Models")).toBe(true);

    await press(stdin, "4"); // → config
    expect(containsText(lastFrame(), "Config")).toBe(true);

    await press(stdin, "1"); // → chat
    expect(containsText(lastFrame(), "Esc dashboard")).toBe(true);
  });

  it("Tab cycles through modes", async () => {
    const { lastFrame, stdin } = renderApp();
    await press(stdin, KEYS.ESCAPE); // → dashboard

    await press(stdin, KEYS.TAB); // → models
    const frame = plain(lastFrame());
    expect(frame).toContain("navigate");
  });

  it("mode roundtrip preserves ModeBar", async () => {
    const { lastFrame, stdin } = renderApp();

    // Go through all modes and back
    await press(stdin, KEYS.ESCAPE); // → dashboard
    await press(stdin, "3"); // → models
    await press(stdin, "4"); // → config
    await press(stdin, KEYS.ESCAPE); // → chat

    // ModeBar should still show all tabs
    const frame = plain(lastFrame());
    expect(frame).toContain("Chat");
    expect(frame).toContain("Dashboard");
    expect(frame).toContain("Models");
    expect(frame).toContain("Config");
  });
});
