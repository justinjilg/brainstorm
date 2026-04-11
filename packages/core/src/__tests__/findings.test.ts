/**
 * Findings module tests — serializer/parser roundtrip, store integration
 * with MemoryManager, filters, summary aggregation.
 *
 * These pin the contract: a finding written via FindingsStore.save() must
 * be recoverable via .list() with identical field values. That's the
 * base guarantee for the cross-machine audit workflow.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { MemoryManager } from "../memory/manager.js";
import { FindingsStore } from "../findings/store.js";
import {
  parseFinding,
  serializeFinding,
  severityRank,
  makeFindingId,
  FINDING_MARKER,
  type CodebaseFinding,
} from "../findings/types.js";

function getMemoryDir(projectPath: string): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".brainstorm", "projects", hash, "memory");
}

function makeStore(): {
  store: FindingsStore;
  memory: MemoryManager;
  projectPath: string;
  cleanup: () => void;
} {
  const projectPath = join(
    tmpdir(),
    `findings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const memory = new MemoryManager(projectPath);
  const store = new FindingsStore(memory);
  return {
    store,
    memory,
    projectPath,
    cleanup: () => {
      try {
        rmSync(getMemoryDir(projectPath), { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("findings serializer", () => {
  it("roundtrips a full finding through serialize → parse", () => {
    const finding: CodebaseFinding = {
      id: "packages-auth-jwt-verify-missing-aud",
      title: "JWT verify missing audience check",
      description:
        "The verifyToken helper calls jwt.verify without setting audience, allowing tokens from other services to be accepted.",
      severity: "high",
      category: "security",
      file: "packages/auth/src/jwt.ts",
      lineStart: 42,
      lineEnd: 58,
      suggestedFix:
        "Add { audience: ['api.brainstorm.co'] } to the verify options.",
      discoveredBy: "openai/gpt-5.4",
      discoveredAt: 1775920000,
      tags: ["jwt", "security-critical"],
    };

    const serialized = serializeFinding(finding);
    expect(serialized.startsWith(FINDING_MARKER)).toBe(true);

    const parsed = parseFinding(serialized);
    expect(parsed).toEqual(finding);
  });

  it("parses findings with trailing commentary after the JSON", () => {
    const finding: CodebaseFinding = {
      id: "test-1",
      title: "t",
      description: "d",
      severity: "low",
      category: "tech-debt",
      file: "f.ts",
      discoveredAt: 1,
    };
    const content =
      serializeFinding(finding) + "\n\nAgent notes: minor cleanup candidate.";
    const parsed = parseFinding(content);
    expect(parsed?.id).toBe("test-1");
    expect(parsed?.title).toBe("t");
  });

  it("returns null when content lacks the marker", () => {
    expect(parseFinding("just a regular memory entry")).toBeNull();
    expect(parseFinding("{not a finding}")).toBeNull();
  });

  it("returns null when marker is present but JSON is malformed", () => {
    expect(parseFinding(`${FINDING_MARKER}\n{ not json at all`)).toBeNull();
  });

  it("returns null when JSON is well-formed but missing required fields", () => {
    const bad = `${FINDING_MARKER}\n${JSON.stringify({ id: "x" })}`;
    expect(parseFinding(bad)).toBeNull();
  });

  it("returns null when severity is not a valid enum value", () => {
    const bad = `${FINDING_MARKER}\n${JSON.stringify({
      id: "x",
      title: "x",
      description: "x",
      severity: "catastrophic", // invalid
      category: "security",
      file: "x.ts",
      discoveredAt: 1,
    })}`;
    expect(parseFinding(bad)).toBeNull();
  });
});

describe("severityRank", () => {
  it("orders critical < high < medium < low < info", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
    expect(severityRank("low")).toBeLessThan(severityRank("info"));
  });
});

describe("makeFindingId", () => {
  it("produces a deterministic slug from file + title + line", () => {
    const a = makeFindingId(
      "packages/auth/jwt.ts",
      "Missing audience check",
      42,
    );
    const b = makeFindingId(
      "packages/auth/jwt.ts",
      "Missing audience check",
      42,
    );
    expect(a).toBe(b);
  });

  it("changes when any of file/title/line change", () => {
    const base = makeFindingId("f.ts", "bug", 10);
    expect(makeFindingId("g.ts", "bug", 10)).not.toBe(base);
    expect(makeFindingId("f.ts", "different", 10)).not.toBe(base);
    expect(makeFindingId("f.ts", "bug", 20)).not.toBe(base);
  });

  it("truncates to 60 chars max", () => {
    const longTitle = "x".repeat(500);
    const id = makeFindingId("f.ts", longTitle, 1);
    expect(id.length).toBeLessThanOrEqual(60);
  });
});

describe("FindingsStore — save and list", () => {
  it("saves a finding that is recoverable via list()", () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    const saved = store.save({
      title: "Unused import",
      description: "file imports fs but never uses it",
      severity: "low",
      category: "tech-debt",
      file: "src/foo.ts",
      lineStart: 3,
    });

    expect(saved.id).toBeDefined();
    expect(saved.discoveredAt).toBeGreaterThan(0);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(saved.id);
    expect(all[0].title).toBe("Unused import");
  });

  it("uses the supplied id when one is provided (update semantics)", () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    store.save({
      id: "fixed-id-1",
      title: "v1",
      description: "d",
      severity: "medium",
      category: "correctness",
      file: "f.ts",
    });
    store.save({
      id: "fixed-id-1",
      title: "v2", // update
      description: "d",
      severity: "high",
      category: "correctness",
      file: "f.ts",
    });

    const all = store.list();
    expect(all).toHaveLength(1); // no dupe
    expect(all[0].title).toBe("v2");
    expect(all[0].severity).toBe("high");
  });

  it("sorts findings by severity (critical first) then file", () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    store.save({
      title: "info-finding",
      description: "d",
      severity: "info",
      category: "documentation",
      file: "z.ts",
    });
    store.save({
      title: "crit-finding",
      description: "d",
      severity: "critical",
      category: "security",
      file: "a.ts",
    });
    store.save({
      title: "high-finding",
      description: "d",
      severity: "high",
      category: "security",
      file: "b.ts",
    });

    const all = store.list();
    expect(all[0].severity).toBe("critical");
    expect(all[1].severity).toBe("high");
    expect(all[2].severity).toBe("info");
  });

  it("delete removes the finding from the store", () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    const saved = store.save({
      title: "t",
      description: "d",
      severity: "low",
      category: "tech-debt",
      file: "f.ts",
    });

    expect(store.delete(saved.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
});

describe("FindingsStore — filters", () => {
  function seeded(): {
    store: FindingsStore;
    cleanup: () => void;
  } {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    store.save({
      title: "SQL injection in auth",
      description: "",
      severity: "critical",
      category: "security",
      file: "packages/auth/src/login.ts",
    });
    store.save({
      title: "Missing input validation",
      description: "",
      severity: "high",
      category: "security",
      file: "packages/auth/src/signup.ts",
    });
    store.save({
      title: "N+1 query in project list",
      description: "",
      severity: "high",
      category: "performance",
      file: "packages/projects/src/list.ts",
    });
    store.save({
      title: "Dead code",
      description: "",
      severity: "low",
      category: "tech-debt",
      file: "packages/projects/src/legacy.ts",
    });

    return { store, cleanup };
  }

  it("filters by single severity", () => {
    const { store } = seeded();
    const highs = store.list({ severity: "high" });
    expect(highs).toHaveLength(2);
    expect(highs.every((f) => f.severity === "high")).toBe(true);
  });

  it("filters by multiple severities", () => {
    const { store } = seeded();
    const urgent = store.list({ severity: ["critical", "high"] });
    expect(urgent).toHaveLength(3);
  });

  it("filters by category", () => {
    const { store } = seeded();
    const sec = store.list({ category: "security" });
    expect(sec).toHaveLength(2);
    expect(sec.every((f) => f.category === "security")).toBe(true);
  });

  it("filters by file substring", () => {
    const { store } = seeded();
    const auth = store.list({ file: "packages/auth" });
    expect(auth).toHaveLength(2);
  });

  it("filters by free-text query against title + description + file", () => {
    const { store } = seeded();
    const nplusone = store.list({ query: "N+1" });
    expect(nplusone).toHaveLength(1);
    expect(nplusone[0].title).toContain("N+1");
  });

  it("combines multiple filter dimensions", () => {
    const { store } = seeded();
    const highSec = store.list({ severity: "high", category: "security" });
    expect(highSec).toHaveLength(1);
    expect(highSec[0].title).toBe("Missing input validation");
  });
});

describe("FindingsStore — summary", () => {
  it("produces counts by severity, category, file", () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    store.save({
      title: "A",
      description: "",
      severity: "critical",
      category: "security",
      file: "a.ts",
    });
    store.save({
      title: "B",
      description: "",
      severity: "critical",
      category: "security",
      file: "a.ts",
    });
    store.save({
      title: "C",
      description: "",
      severity: "medium",
      category: "performance",
      file: "b.ts",
    });

    const summary = store.summary();
    expect(summary.total).toBe(3);
    expect(summary.bySeverity.critical).toBe(2);
    expect(summary.bySeverity.medium).toBe(1);
    expect(summary.bySeverity.high).toBe(0);
    expect(summary.byCategory.security).toBe(2);
    expect(summary.byCategory.performance).toBe(1);
    expect(summary.byFile[0]).toEqual({ file: "a.ts", count: 2 });
    expect(summary.topCritical.map((f) => f.title).sort()).toEqual(["A", "B"]);
  });

  it("empty summary returns zeros + empty arrays", () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);

    const summary = store.summary();
    expect(summary.total).toBe(0);
    expect(summary.bySeverity.critical).toBe(0);
    expect(summary.byFile).toEqual([]);
    expect(summary.topCritical).toEqual([]);
  });
});
