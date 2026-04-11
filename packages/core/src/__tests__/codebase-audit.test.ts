/**
 * Codebase audit tests — the pure pieces (scope discovery, finding
 * extraction from agent output, prompt building). The full orchestrator
 * needs live subagents and gets exercised by a live dogfood run rather
 * than unit tests here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverScopes,
  buildAuditPrompt,
  extractFindings,
} from "../plan/codebase-audit.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeTempProject(layout: Record<string, boolean>): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  for (const [path, _isDir] of Object.entries(layout)) {
    const full = join(dir, path);
    mkdirSync(full, { recursive: true });
    // Drop a placeholder file so it's not an empty dir
    writeFileSync(join(full, ".keep"), "");
  }
  return dir;
}

describe("discoverScopes", () => {
  it("returns one scope per packages/* directory in a monorepo layout", () => {
    const project = makeTempProject({
      "packages/auth": true,
      "packages/db": true,
      "packages/ui": true,
    });

    const scopes = discoverScopes(project);
    expect(scopes.map((s) => s.name).sort()).toEqual([
      "packages/auth",
      "packages/db",
      "packages/ui",
    ]);
  });

  it("includes apps/* directories alongside packages/*", () => {
    const project = makeTempProject({
      "packages/core": true,
      "apps/web": true,
      "apps/cli": true,
    });

    const scopes = discoverScopes(project);
    const names = scopes.map((s) => s.name);
    expect(names).toContain("packages/core");
    expect(names).toContain("apps/web");
    expect(names).toContain("apps/cli");
  });

  it("skips node_modules, dist, build, .git, .turbo", () => {
    const project = makeTempProject({
      "packages/real": true,
      "packages/node_modules": true, // should be skipped
      "packages/.git": true, // should be skipped
      "packages/dist": true,
    });

    const scopes = discoverScopes(project);
    const names = scopes.map((s) => s.name);
    expect(names).toContain("packages/real");
    expect(names).not.toContain("packages/node_modules");
    expect(names).not.toContain("packages/.git");
    expect(names).not.toContain("packages/dist");
  });

  it("falls back to src/* when no packages or apps exist", () => {
    const project = makeTempProject({
      "src/lib": true,
      "src/cli": true,
      "src/utils": true,
    });

    const scopes = discoverScopes(project);
    const names = scopes.map((s) => s.name).sort();
    expect(names).toEqual(["src/cli", "src/lib", "src/utils"]);
  });

  it("returns one scope for the whole project when no recognized layout", () => {
    const project = makeTempProject({
      "random/dir": true,
    });

    const scopes = discoverScopes(project);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].name).toBe("(root)");
  });

  it("sorts scopes deterministically for repeatable runs", () => {
    const project = makeTempProject({
      "packages/zeta": true,
      "packages/alpha": true,
      "packages/beta": true,
    });

    const scopes = discoverScopes(project);
    expect(scopes.map((s) => s.name)).toEqual([
      "packages/alpha",
      "packages/beta",
      "packages/zeta",
    ]);
  });
});

describe("buildAuditPrompt", () => {
  it("includes the scope name, path, and categories", () => {
    const prompt = buildAuditPrompt(
      { name: "packages/auth", path: "/repo/packages/auth" },
      ["security", "correctness"],
      "medium",
    );

    expect(prompt).toContain("packages/auth");
    expect(prompt).toContain("/repo/packages/auth");
    expect(prompt).toContain("security");
    expect(prompt).toContain("correctness");
    expect(prompt).toContain("medium");
  });

  it("tells the worker NOT to wrap findings in markdown code fences", () => {
    const prompt = buildAuditPrompt(
      { name: "x", path: "/x" },
      ["security"],
      "low",
    );
    expect(prompt).toContain("not wrap it in markdown");
  });

  it("enforces read-only scope", () => {
    const prompt = buildAuditPrompt(
      { name: "x", path: "/x" },
      ["security"],
      "low",
    );
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("Do not modify");
  });
});

describe("extractFindings", () => {
  it("parses a single finding from agent output", () => {
    const output = `Looking at this package now.

[FINDING]
{
  "id": "auth-jwt-no-aud",
  "title": "JWT verify without audience check",
  "description": "The verifyToken helper accepts tokens from any issuer.",
  "severity": "high",
  "category": "security",
  "file": "packages/auth/src/jwt.ts",
  "lineStart": 42,
  "discoveredAt": 1775920000
}

That's one issue. Moving on.`;

    const findings = extractFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("auth-jwt-no-aud");
    expect(findings[0].severity).toBe("high");
  });

  it("parses multiple findings from one output", () => {
    const output = `
[FINDING]
{"id":"a","title":"a","description":"d","severity":"low","category":"tech-debt","file":"f.ts","discoveredAt":1}

Some prose in between.

[FINDING]
{"id":"b","title":"b","description":"d","severity":"high","category":"security","file":"g.ts","discoveredAt":2}

[FINDING]
{"id":"c","title":"c","description":"d","severity":"medium","category":"performance","file":"h.ts","discoveredAt":3}
`;

    const findings = extractFindings(output);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("silently skips malformed finding blocks", () => {
    const output = `
[FINDING]
{"id":"good","title":"t","description":"d","severity":"low","category":"security","file":"f.ts","discoveredAt":1}

[FINDING]
{ this is not valid json }

[FINDING]
{"id":"also-good","title":"t","description":"d","severity":"info","category":"documentation","file":"g.ts","discoveredAt":2}
`;

    const findings = extractFindings(output);
    expect(findings.map((f) => f.id).sort()).toEqual(["also-good", "good"]);
  });

  it("returns empty array when no [FINDING] markers present", () => {
    expect(
      extractFindings("just regular agent output\nno findings here"),
    ).toEqual([]);
  });

  it("handles [FINDING] markers that contain prose AFTER the JSON", () => {
    // The parser should find the first complete JSON object and ignore trailing text
    const output = `[FINDING]
{"id":"x","title":"t","description":"d","severity":"low","category":"tech-debt","file":"f.ts","discoveredAt":1}
This finding was identified by static analysis.`;

    const findings = extractFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("x");
  });
});
