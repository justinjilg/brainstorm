import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSystemPrompt,
  buildToolAwarenessSection,
  getPromptTierForComplexity,
} from "../agent/context.js";

/**
 * Phase 5 — context/token efficiency.
 *
 * Covers:
 *  1. trivial/simple complexity → materially shorter prompt, heavy segments dropped
 *  2. moderate/complex → full prompt (heavy segments present)
 *  3. cacheable prefix byte-identical across builds with different process.cwd()
 *  4. skills listing emitted in deterministic (sorted) order
 */

const HEAVY_HEADINGS = [
  "## Project Context",
  "## Code Patterns (MANDATORY)",
  "## Architecture Constraints",
  "## Stack",
  "## Dependency Rules",
  "## Project Structure", // repo map
];

// STORM/BRAINSTORM.md exercising every extracted section.
const STORM_BODY = `---
version: 1
build_command: npm run build
test_command: npm test
---

## Conventions

- Use tabs, not spaces.
- Always name booleans with an "is" prefix.

## Architecture

- Never import from a sibling package's internals.

## Stack

- TypeScript, Node 22, vitest.

## Dependencies

- No runtime deps without approval.

## Don't touch

- src/generated/**
`;

let projectDir: string;
let cwdA: string;
let cwdB: string;
const originalCwd = process.cwd();

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "storm-proj-"));
  writeFileSync(join(projectDir, "BRAINSTORM.md"), STORM_BODY);

  // A couple of source files so the repo map (full tier) has something to show.
  // (Not a git repo → repo map may be empty; the heavy-heading assertions below
  // do not depend on the repo map being populated, only on STORM sections.)
  writeFileSync(join(projectDir, "index.ts"), "export const x = 1;\n");

  // Project skills in intentionally NON-alphabetical creation order to prove
  // the output is sorted regardless of filesystem/creation order.
  const skillsDir = join(projectDir, ".brainstorm", "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const name of ["zebra", "alpha", "mango"]) {
    writeFileSync(
      join(skillsDir, `${name}.md`),
      `---\ndescription: ${name} skill\n---\n# ${name}\n`,
    );
  }

  cwdA = mkdtempSync(join(tmpdir(), "cwd-a-"));
  cwdB = mkdtempSync(join(tmpdir(), "cwd-b-"));
});

afterEach(() => {
  process.chdir(originalCwd);
});

afterAll(() => {
  process.chdir(originalCwd);
  for (const d of [projectDir, cwdA, cwdB]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("getPromptTierForComplexity", () => {
  it("mirrors the tool-tiering split: trivial/simple → minimal, else full", () => {
    expect(getPromptTierForComplexity("trivial")).toBe("minimal");
    expect(getPromptTierForComplexity("simple")).toBe("minimal");
    expect(getPromptTierForComplexity("moderate")).toBe("full");
    expect(getPromptTierForComplexity("complex")).toBe("full");
    expect(getPromptTierForComplexity("expert")).toBe("full");
  });

  it("defaults undefined complexity to full (backward-compatible)", () => {
    expect(getPromptTierForComplexity(undefined)).toBe("full");
  });
});

describe("complexity-aware prompt tiering", () => {
  it("drops heavy segments for trivial/simple tasks", () => {
    const trivial = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "trivial",
    );
    const simple = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "simple",
    );

    for (const tier of [trivial, simple]) {
      for (const heading of HEAVY_HEADINGS) {
        expect(tier.prompt).not.toContain(heading);
      }
      // Style guide is also a heavy, full-tier-only segment.
      expect(tier.prompt).not.toContain("## Project Style Guide");
    }
  });

  it("keeps the always-present core + safety segments at the minimal tier", () => {
    const trivial = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "trivial",
    );
    // Identity / core prompt.
    expect(trivial.prompt).toContain("You are Brainstorm");
    // Safety-relevant sections survive even the lean prefix.
    expect(trivial.prompt).toContain("## Verification Commands");
    expect(trivial.prompt).toContain("## Protected Areas");
    // frontmatter (build/test commands) is still parsed for downstream routing.
    expect(trivial.frontmatter?.build_command).toBe("npm run build");
  });

  it("keeps the full prompt for moderate/complex (today's behavior)", () => {
    const moderate = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "moderate",
    );
    const complex = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "complex",
    );

    for (const tier of [moderate, complex]) {
      expect(tier.prompt).toContain("## Project Context");
      expect(tier.prompt).toContain("## Code Patterns (MANDATORY)");
      expect(tier.prompt).toContain("## Architecture Constraints");
      expect(tier.prompt).toContain("## Stack");
      expect(tier.prompt).toContain("## Dependency Rules");
    }
  });

  it("full-tier build is byte-identical whether complexity is undefined or moderate", () => {
    const undef = buildSystemPrompt(projectDir);
    const moderate = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "moderate",
    );
    // Only the dynamic (date) segment varies; compare the cacheable prefix.
    expect(undef.segments[0].text).toBe(moderate.segments[0].text);
  });

  it("minimal tier is materially shorter than the full tier", () => {
    const trivial = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "trivial",
    );
    const full = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "moderate",
    );
    expect(trivial.segments[0].text.length).toBeLessThan(
      full.segments[0].text.length,
    );
  });
});

describe("prefix stability (cache protection)", () => {
  it("cacheable prefix is byte-identical across different process.cwd()", () => {
    process.chdir(cwdA);
    const a = buildSystemPrompt(projectDir, undefined, undefined, "moderate");
    process.chdir(cwdB);
    const b = buildSystemPrompt(projectDir, undefined, undefined, "moderate");

    expect(a.segments[0].cacheable).toBe(true);
    expect(a.segments[0].text).toBe(b.segments[0].text);
  });

  it("cacheable prefix is byte-identical across cwd at the minimal tier too", () => {
    process.chdir(cwdA);
    const a = buildSystemPrompt(projectDir, undefined, undefined, "trivial");
    process.chdir(cwdB);
    const b = buildSystemPrompt(projectDir, undefined, undefined, "trivial");
    expect(a.segments[0].text).toBe(b.segments[0].text);
  });

  it("tool-awareness section does not bake process.cwd() into the cached zone", () => {
    process.chdir(cwdA);
    const a = buildToolAwarenessSection([
      { name: "file_read", description: "read", permission: "read" },
    ]);
    process.chdir(cwdB);
    const b = buildToolAwarenessSection([
      { name: "file_read", description: "read", permission: "read" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toContain(cwdA);
    expect(a).not.toContain("Current working directory");
  });

  it("keeps date/memory in the dynamic (non-cached) segment", () => {
    const full = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "moderate",
    );
    expect(full.segments[1].cacheable).toBe(false);
    expect(full.segments[1].text).toContain("## Current Date");
    // The cacheable prefix must never contain the volatile date section.
    expect(full.segments[0].text).not.toContain("## Current Date");
  });
});

describe("skills listing determinism", () => {
  it("emits project skills in sorted order regardless of creation order", () => {
    const full = buildSystemPrompt(
      projectDir,
      undefined,
      undefined,
      "moderate",
    );
    const text = full.segments[0].text;
    const ai = text.indexOf("/alpha");
    const mi = text.indexOf("/mango");
    const zi = text.indexOf("/zebra");
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(mi).toBeGreaterThan(ai);
    expect(zi).toBeGreaterThan(mi);
  });

  it("produces byte-identical skills output across repeated builds", () => {
    const a = buildSystemPrompt(projectDir, undefined, undefined, "moderate");
    const b = buildSystemPrompt(projectDir, undefined, undefined, "moderate");
    const extract = (t: string) => {
      const start = t.indexOf("## Available Skills");
      return start >= 0 ? t.slice(start) : "";
    };
    expect(extract(a.segments[0].text)).toBe(extract(b.segments[0].text));
    expect(extract(a.segments[0].text)).toContain("/alpha");
  });
});
