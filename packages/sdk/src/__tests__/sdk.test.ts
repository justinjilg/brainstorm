/**
 * SDK smoke tests — validates the Brainstorm class can be instantiated.
 */

import { describe, it, expect } from "vitest";

// The SDK imports heavy dependencies (config, db, providers, router, core)
// so we test the import chain works without instantiating the full stack
describe("SDK", () => {
  it("exports Brainstorm class", async () => {
    const mod = await import("../index.js");
    expect(mod.Brainstorm).toBeDefined();
    expect(typeof mod.Brainstorm).toBe("function");
  });

  it("Brainstorm class has run method", async () => {
    const { Brainstorm } = await import("../index.js");
    expect(typeof Brainstorm.prototype.run).toBe("function");
  });
});
