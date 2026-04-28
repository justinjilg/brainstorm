/**
 * Tests for the harness directory walker — initial population entry point
 * for the index. Covers: ignore globs, depth bounds, TOML/markdown parsing,
 * artifact-kind heuristics, broken files surfaced as parse_errors, and
 * the extractIndexFields helper.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkHarnessDir, detectKind, extractIndexFields } from "../walker.js";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "harness-walker-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): void {
  const abs = join(testRoot, relativePath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// ── walkHarnessDir — basic crawl ─────────────────────────────

describe("walkHarnessDir", () => {
  test("returns empty when root has no files", () => {
    const result = walkHarnessDir(testRoot);
    expect(result.artifacts).toEqual([]);
    expect(result.parse_errors).toEqual([]);
    expect(result.total_files_seen).toBe(0);
  });

  test("walks nested directories and hashes every file", () => {
    writeFile("identity/identity.toml", 'id = "biz_x"\nname = "X"\n');
    writeFile("team/humans/justin.toml", 'id = "person_p1"\nname = "Justin"\n');
    writeFile(
      "customers/accounts/acme/account.toml",
      'id = "acct_acme"\nname = "Acme"\n',
    );

    const result = walkHarnessDir(testRoot);
    expect(result.total_files_seen).toBe(3);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.every((a) => a.content_hash.length === 64)).toBe(
      true,
    );
  });

  test("ignores .harness/index/ and node_modules/ by default", () => {
    writeFile("real.toml", "x = 1\n");
    writeFile(".harness/index/cache.db", "binary garbage");
    writeFile("node_modules/foo/index.js", "module.exports = {};");

    const result = walkHarnessDir(testRoot);
    expect(result.artifacts.map((a) => a.relativePath)).toEqual(["real.toml"]);
  });

  test("custom ignoredDirs override default set", () => {
    writeFile("a.toml", "x = 1\n");
    writeFile(".harness/index/cache.db", "x");
    const result = walkHarnessDir(testRoot, { ignoredDirs: [] });
    expect(result.artifacts.map((a) => a.relativePath).sort()).toEqual([
      ".harness/index/cache.db",
      "a.toml",
    ]);
  });

  test("respects maxDepth", () => {
    writeFile("a/b/c/d/e/f/deep.toml", "x = 1\n");
    const shallow = walkHarnessDir(testRoot, { maxDepth: 2 });
    expect(shallow.artifacts).toEqual([]);
    const deep = walkHarnessDir(testRoot, { maxDepth: 12 });
    expect(deep.artifacts).toHaveLength(1);
  });

  test("populates duration_ms and totals", () => {
    writeFile("a.toml", "x = 1\n");
    writeFile("b.md", "# Hello\n");
    const result = walkHarnessDir(testRoot);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.total_files_seen).toBe(2);
    expect(result.total_bytes).toBeGreaterThan(0);
  });
});

// ── TOML + markdown frontmatter parsing ──────────────────────

describe("walkHarnessDir — frontmatter parsing", () => {
  test("parses well-formed TOML frontmatter into the artifact", () => {
    writeFile(
      "team/humans/justin.toml",
      `id = "person_p1"
name = "Justin"
owner = "team/humans/justin"
tags = ["founder", "active"]

[[references]]
target = "customers/accounts/acme"
type = "owner-of"
`,
    );
    const result = walkHarnessDir(testRoot);
    const artifact = result.artifacts[0]!;
    expect(artifact.frontmatter).not.toBeNull();
    expect(artifact.frontmatter!.name).toBe("Justin");
    expect(Array.isArray(artifact.frontmatter!.tags)).toBe(true);
  });

  test("malformed TOML is recorded as parse_error but file still hashed", () => {
    writeFile("broken.toml", "[unclosed\n");
    const result = walkHarnessDir(testRoot);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.frontmatter).toBeNull();
    expect(result.parse_errors).toHaveLength(1);
    expect(result.parse_errors[0]!.path).toBe("broken.toml");
  });

  test("parses TOML-fenced markdown frontmatter (+++ ... +++)", () => {
    writeFile(
      "governance/decisions/2026-01-01-pivot.md",
      `+++
id = "dec_pivot"
status = "accepted"
deciders = ["team/humans/justin"]
+++

# Pivot decision

We pivoted because...
`,
    );
    const result = walkHarnessDir(testRoot);
    const artifact = result.artifacts[0]!;
    expect(artifact.frontmatter!.id).toBe("dec_pivot");
    expect(artifact.frontmatter!.status).toBe("accepted");
  });

  test("YAML-fenced markdown returns simple key/value pairs", () => {
    writeFile(
      "doc.md",
      `---
title: Hello
status: draft
---

Body
`,
    );
    const result = walkHarnessDir(testRoot);
    expect(result.artifacts[0]!.frontmatter!.title).toBe("Hello");
    expect(result.artifacts[0]!.frontmatter!.status).toBe("draft");
  });

  test("plain markdown without frontmatter has frontmatter=null", () => {
    writeFile("readme.md", "# Hello\n\nNo frontmatter here.\n");
    const result = walkHarnessDir(testRoot);
    expect(result.artifacts[0]!.frontmatter).toBeNull();
  });

  test("non-parsed extensions get null frontmatter but are still indexed", () => {
    writeFile("data/blob.bin", "binary stuff");
    writeFile("scripts/foo.js", "module.exports = 1;");
    const result = walkHarnessDir(testRoot);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every((a) => a.frontmatter === null)).toBe(true);
  });
});

// ── detectKind heuristics ────────────────────────────────────

describe("detectKind", () => {
  test.each<[string, string]>([
    ["business.toml", "manifest"],
    ["team/humans/justin.toml", "human"],
    ["team/agents/kairos.toml", "agent"],
    ["customers/accounts/acme/account.toml", "account"],
    ["products/peer10/product.toml", "product"],
    ["governance/decisions/2026-01-01-pivot.md", "decision"],
    ["governance/parties/acme.toml", "party"],
    ["team/policies/code-of-conduct.md", "policy"],
    ["operations/security/policies/access.md", "policy"],
    ["team/performance/okrs/2026-Q2/justin.toml", "okr"],
    ["random/file.toml", "other"],
  ])("path %s detects as %s", (path, expected) => {
    expect(detectKind(path, null)).toBe(expected);
  });

  test("falls back to id-prefix in frontmatter", () => {
    expect(detectKind("random/x.toml", { id: "party_acme" })).toBe("party");
    expect(detectKind("random/x.toml", { id: "person_p1" })).toBe("human");
    expect(detectKind("random/x.toml", { id: "agent_kairos" })).toBe("agent");
    expect(detectKind("random/x.toml", { id: "prod_x" })).toBe("product");
    expect(detectKind("random/x.toml", { id: "acct_a" })).toBe("account");
  });
});

// ── extractIndexFields ───────────────────────────────────────

describe("extractIndexFields", () => {
  test("extracts owner / tags / status / reviewed_at", () => {
    const result = extractIndexFields({
      owner: "team/humans/justin",
      tags: ["founder", "active"],
      status: "active",
      reviewed_at: "2026-04-15T10:00:00Z",
    });
    expect(result.owner).toBe("team/humans/justin");
    expect(result.tags).toEqual(["founder", "active"]);
    expect(result.status).toBe("active");
    expect(result.reviewed_at).toBe(Date.parse("2026-04-15T10:00:00Z"));
  });

  test("string references are normalized to { target }", () => {
    const result = extractIndexFields({
      references: ["customers/accounts/acme", "products/peer10"],
    });
    expect(result.references).toEqual([
      { target: "customers/accounts/acme" },
      { target: "products/peer10" },
    ]);
  });

  test("object references retain target + type", () => {
    const result = extractIndexFields({
      references: [
        { target: "customers/accounts/acme", type: "owner-of" },
        { target: "products/peer10" },
      ],
    });
    expect(result.references).toEqual([
      { target: "customers/accounts/acme", type: "owner-of" },
      { target: "products/peer10" },
    ]);
  });

  test("missing/null frontmatter returns empty defaults", () => {
    const result = extractIndexFields(null);
    expect(result.owner).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.reviewed_at).toBeNull();
  });

  test("non-string values in tags array are filtered out", () => {
    const result = extractIndexFields({
      tags: ["valid", 42, null, "ok"],
    });
    expect(result.tags).toEqual(["valid", "ok"]);
  });
});

// ── integration: walk → extract → ready-for-index ────────────

describe("walk → extract integration", () => {
  test("a fully populated harness fans out cleanly", () => {
    writeFile(
      "business.toml",
      `[identity]
id = "biz_test"
name = "Test"
archetype = "saas-platform"
`,
    );
    writeFile(
      "team/humans/justin.toml",
      `id = "person_p1"
name = "Justin"
owner = "team/humans/justin"
tags = ["founder"]
references = ["customers/accounts/acme"]
`,
    );
    writeFile(
      "customers/accounts/acme/account.toml",
      `id = "acct_acme"
name = "Acme Corp"
owner = "team/humans/justin"
tags = ["enterprise"]
references = ["products/peer10"]
`,
    );

    const result = walkHarnessDir(testRoot);
    expect(result.artifacts).toHaveLength(3);

    const justin = result.artifacts.find(
      (a) => a.relativePath === "team/humans/justin.toml",
    )!;
    expect(justin.kind).toBe("human");
    const fields = extractIndexFields(justin.frontmatter);
    expect(fields.owner).toBe("team/humans/justin");
    expect(fields.references).toEqual([{ target: "customers/accounts/acme" }]);
  });
});
