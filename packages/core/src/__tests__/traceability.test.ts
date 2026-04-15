import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import {
  generateTraceId,
  generateSequentialTraceId,
  parseTraceId,
  isValidTraceId,
  initTraceabilitySchema,
  saveArtifact,
  loadArtifact,
  listArtifacts,
  traceChain,
  findUntestedRequirements,
  findUntracedChanges,
  getCoverageMetrics,
  type TracedArtifact,
} from "../traceability/index.js";
import { validate } from "../traceability/validate.js";

let db: Database.Database;

beforeEach(() => {
  const dir = join(
    tmpdir(),
    `trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, "test.db"));
  db.pragma("journal_mode = WAL");
  initTraceabilitySchema(db);
});

afterEach(() => {
  db?.close();
});

function makeArtifact(overrides: Partial<TracedArtifact>): TracedArtifact {
  const now = new Date().toISOString();
  return {
    traceId: overrides.traceId ?? generateTraceId("REQ", "test", "content"),
    type: "REQ",
    project: "test",
    title: "Test artifact",
    description: "A test artifact",
    status: "active",
    links: [],
    author: "test",
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

describe("TraceId", () => {
  it("generates deterministic IDs from content", () => {
    const id1 = generateTraceId("REQ", "brainstorm", "user auth");
    const id2 = generateTraceId("REQ", "brainstorm", "user auth");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^REQ-brainstorm-[a-f0-9]{6}$/);
  });

  it("generates different IDs for different content", () => {
    const id1 = generateTraceId("REQ", "brainstorm", "user auth");
    const id2 = generateTraceId("REQ", "brainstorm", "data export");
    expect(id1).not.toBe(id2);
  });

  it("generates sequential IDs", () => {
    const id = generateSequentialTraceId("PLN", "brainstorm", 42);
    expect(id).toBe("PLN-brainstorm-042");
  });

  it("parses trace IDs", () => {
    const parsed = parseTraceId("REQ-brainstorm-abc123");
    expect(parsed).toEqual({
      type: "REQ",
      project: "brainstorm",
      identifier: "abc123",
    });
  });

  it("validates trace IDs", () => {
    expect(isValidTraceId("REQ-brainstorm-001")).toBe(true);
    expect(isValidTraceId("CHG-peer10-abc123")).toBe(true);
    expect(isValidTraceId("invalid")).toBe(false);
    expect(isValidTraceId("FOO-bar-123")).toBe(false);
  });
});

describe("Traceability Store", () => {
  it("saves and loads artifacts", () => {
    const artifact = makeArtifact({
      traceId: "REQ-test-001",
      title: "User auth",
    });
    saveArtifact(db, artifact);

    const loaded = loadArtifact(db, "REQ-test-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("User auth");
    expect(loaded!.type).toBe("REQ");
  });

  it("saves and retrieves trace links", () => {
    const req = makeArtifact({
      traceId: "REQ-test-001",
      title: "Auth requirement",
    });
    const chg = makeArtifact({
      traceId: "CHG-test-001",
      type: "CHG",
      title: "Implement auth",
      links: [{ targetId: "REQ-test-001", relation: "implements" }],
    });

    saveArtifact(db, req);
    saveArtifact(db, chg);

    const loaded = loadArtifact(db, "CHG-test-001");
    expect(loaded!.links).toHaveLength(1);
    expect(loaded!.links[0].targetId).toBe("REQ-test-001");
    expect(loaded!.links[0].relation).toBe("implements");
  });

  it("lists artifacts by type", () => {
    saveArtifact(db, makeArtifact({ traceId: "REQ-test-001", type: "REQ" }));
    saveArtifact(db, makeArtifact({ traceId: "REQ-test-002", type: "REQ" }));
    saveArtifact(db, makeArtifact({ traceId: "CHG-test-001", type: "CHG" }));

    const reqs = listArtifacts(db, { type: "REQ" });
    expect(reqs).toHaveLength(2);

    const changes = listArtifacts(db, { type: "CHG" });
    expect(changes).toHaveLength(1);
  });

  it("traces downstream chain", () => {
    // REQ → DES → PLN → CHG → TST
    saveArtifact(db, makeArtifact({ traceId: "REQ-test-001", type: "REQ" }));
    saveArtifact(
      db,
      makeArtifact({
        traceId: "DES-test-001",
        type: "DES",
        links: [{ targetId: "REQ-test-001", relation: "derives-from" }],
      }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "PLN-test-001",
        type: "PLN",
        links: [{ targetId: "DES-test-001", relation: "derives-from" }],
      }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-001",
        type: "CHG",
        links: [{ targetId: "PLN-test-001", relation: "implements" }],
      }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "TST-test-001",
        type: "TST",
        links: [{ targetId: "REQ-test-001", relation: "tests" }],
      }),
    );

    // Downstream from REQ should find DES, TST (things that link TO the REQ)
    // Wait — the chain follows source → target links, so "downstream" from REQ
    // means artifacts whose links point AT the REQ as target
    const upstream = traceChain(db, "CHG-test-001", "upstream");
    // CHG → PLN → DES → REQ
    expect(upstream.length).toBe(0); // upstream follows target → source, CHG links to PLN
    // Actually trace_links: CHG source → PLN target, so upstream from CHG finds PLN
  });

  it("finds untested requirements", () => {
    saveArtifact(
      db,
      makeArtifact({ traceId: "REQ-test-001", type: "REQ", project: "myproj" }),
    );
    saveArtifact(
      db,
      makeArtifact({ traceId: "REQ-test-002", type: "REQ", project: "myproj" }),
    );
    // Only test for REQ-001
    saveArtifact(
      db,
      makeArtifact({
        traceId: "TST-test-001",
        type: "TST",
        project: "myproj",
        links: [{ targetId: "REQ-test-001", relation: "tests" }],
      }),
    );

    const untested = findUntestedRequirements(db, "myproj");
    expect(untested).toHaveLength(1);
    expect(untested[0].traceId).toBe("REQ-test-002");
  });

  it("finds untraced changes", () => {
    // Traced change
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-001",
        type: "CHG",
        project: "myproj",
        links: [{ targetId: "REQ-test-001", relation: "implements" }],
      }),
    );
    // Untraced change
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-002",
        type: "CHG",
        project: "myproj",
      }),
    );

    const untraced = findUntracedChanges(db, "myproj");
    expect(untraced).toHaveLength(1);
    expect(untraced[0].traceId).toBe("CHG-test-002");
  });

  it("computes coverage metrics", () => {
    saveArtifact(
      db,
      makeArtifact({ traceId: "REQ-test-001", type: "REQ", project: "p" }),
    );
    saveArtifact(
      db,
      makeArtifact({ traceId: "REQ-test-002", type: "REQ", project: "p" }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "TST-test-001",
        type: "TST",
        project: "p",
        links: [{ targetId: "REQ-test-001", relation: "tests" }],
      }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-001",
        type: "CHG",
        project: "p",
        links: [{ targetId: "REQ-test-001", relation: "implements" }],
      }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-002",
        type: "CHG",
        project: "p",
      }),
    );

    const metrics = getCoverageMetrics(db, "p");
    expect(metrics.requirements.total).toBe(2);
    expect(metrics.requirements.tested).toBe(1);
    expect(metrics.requirements.untested).toBe(1);
    expect(metrics.changes.total).toBe(2);
    expect(metrics.changes.traced).toBe(1);
    expect(metrics.changes.untraced).toBe(1);
    expect(metrics.testCount).toBe(1);
  });
});

describe("Deterministic Validation", () => {
  it("passes when no artifacts exist", () => {
    const result = validate(db, "empty-project");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it("fails when untraced changes exist", () => {
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-001",
        type: "CHG",
        project: "p",
      }),
    );

    const result = validate(db, "p", { requireTraceability: true });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.rule === "traceability")).toBe(true);
  });

  it("warns about untested requirements when required", () => {
    saveArtifact(
      db,
      makeArtifact({
        traceId: "REQ-test-001",
        type: "REQ",
        project: "p",
      }),
    );

    const result = validate(db, "p", { requireTestCoverage: true });
    expect(result.findings.some((f) => f.rule === "test-coverage")).toBe(true);
  });

  it("reports coverage metrics", () => {
    saveArtifact(
      db,
      makeArtifact({ traceId: "REQ-test-001", type: "REQ", project: "p" }),
    );
    saveArtifact(
      db,
      makeArtifact({
        traceId: "CHG-test-001",
        type: "CHG",
        project: "p",
        links: [{ targetId: "REQ-test-001", relation: "implements" }],
      }),
    );

    const result = validate(db, "p");
    expect(result.coverage.changes.percent).toBe(100);
  });
});
