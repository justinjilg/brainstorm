/**
 * Projects context builder tests.
 */

import { describe, it, expect } from "vitest";
import { buildProjectContext } from "../context-builder.js";

const STUB_PROJECT = {
  id: "test-project",
  name: "Test Project",
  path: "/tmp/test-project",
  description: "A test project for unit testing",
  customInstructions: "Always use TypeScript strict mode",
  knowledgeFiles: [],
  budgetDaily: 5.0,
  budgetMonthly: 100.0,
};

describe("buildProjectContext", () => {
  it("includes project name and path", () => {
    const ctx = buildProjectContext(STUB_PROJECT as any, []);
    expect(ctx).toContain("Test Project");
    expect(ctx).toContain("/tmp/test-project");
  });

  it("includes custom instructions", () => {
    const ctx = buildProjectContext(STUB_PROJECT as any, []);
    expect(ctx).toContain("Project Instructions");
    expect(ctx).toContain("TypeScript strict mode");
  });

  it("includes budget info", () => {
    const ctx = buildProjectContext(STUB_PROJECT as any, []);
    expect(ctx).toContain("$5.00");
    expect(ctx).toContain("$100.00");
  });

  it("includes project memory entries by category", () => {
    const memory = [
      {
        key: "no-mocks",
        value: "Always use real DB in tests",
        category: "convention",
      },
      {
        key: "auth-rewrite",
        value: "Migrating from session to JWT",
        category: "decision",
      },
      {
        key: "flaky-ci",
        value: "CI fails intermittently on macOS",
        category: "warning",
      },
    ];
    const ctx = buildProjectContext(STUB_PROJECT as any, memory as any);
    expect(ctx).toContain("Warnings");
    expect(ctx).toContain("flaky-ci");
    expect(ctx).toContain("Conventions");
    expect(ctx).toContain("no-mocks");
    expect(ctx).toContain("Decisions");
    expect(ctx).toContain("auth-rewrite");
  });

  it("puts warnings before conventions", () => {
    const memory = [
      { key: "convention", value: "c", category: "convention" },
      { key: "warning", value: "w", category: "warning" },
    ];
    const ctx = buildProjectContext(STUB_PROJECT as any, memory as any);
    const warningIdx = ctx.indexOf("Warnings");
    const conventionIdx = ctx.indexOf("Conventions");
    expect(warningIdx).toBeLessThan(conventionIdx);
  });

  it("handles empty memory gracefully", () => {
    const ctx = buildProjectContext(STUB_PROJECT as any, []);
    expect(ctx).not.toContain("Project Memory");
  });
});
