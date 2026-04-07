/**
 * Database Migration Tests — catches FK violations, CHECK constraint gaps, and schema drift.
 *
 * These exist because:
 * - Migration order was wrong (010 ran before 009, causing "no such table")
 * - Agent role CHECK constraint had only 8 values, rejecting valid roles
 * - FK cascade behavior was assumed but never verified
 * - cleanupOldRecords ran before migrations, hitting non-existent tables
 */

import { describe, test, expect, afterEach } from "vitest";
import { getTestDb, SessionRepository, CostRepository } from "../index.js";
import type Database from "better-sqlite3";

let db: Database.Database;

afterEach(() => {
  if (db) db.close();
});

describe("Migrations", () => {
  test("all migrations apply cleanly on fresh database", () => {
    db = getTestDb();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("messages");
    expect(names).toContain("cost_records");
    expect(names).toContain("agent_profiles");
    expect(names).toContain("audit_log");
  });

  test("migrations table tracks all applied migrations", () => {
    db = getTestDb();

    const migrations = db
      .prepare("SELECT name FROM _migrations ORDER BY name")
      .all() as { name: string }[];

    expect(migrations.length).toBeGreaterThan(0);
    // First migration should be 001
    expect(migrations[0].name).toMatch(/^001/);
  });

  test("foreign_keys pragma is enabled", () => {
    db = getTestDb();

    const result = db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });
});

describe("Foreign Key Cascades", () => {
  test("cost_records cascade-delete when session deleted", () => {
    db = getTestDb();
    const sessions = new SessionRepository(db);
    const costs = new CostRepository(db);

    const session = sessions.create("/test/path");

    costs.record({
      sessionId: session.id,
      timestamp: Math.floor(Date.now() / 1000),
      modelId: "claude-opus-4-6",
      provider: "anthropic",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      cost: 0.001,
      taskType: "code-gen" as any,
    });

    // Verify cost record exists
    const before = db
      .prepare("SELECT COUNT(*) as cnt FROM cost_records WHERE session_id = ?")
      .get(session.id) as { cnt: number };
    expect(before.cnt).toBe(1);

    // Delete session
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);

    // Cost record should cascade-delete
    const after = db
      .prepare("SELECT COUNT(*) as cnt FROM cost_records WHERE session_id = ?")
      .get(session.id) as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test("messages cascade-delete when session deleted", () => {
    db = getTestDb();
    const sessions = new SessionRepository(db);

    const session = sessions.create("/test/path");

    db.prepare(
      "INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    ).run("msg-1", session.id, "user", "hello");

    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);

    const after = db
      .prepare("SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?")
      .get(session.id) as { cnt: number };
    expect(after.cnt).toBe(0);
  });
});

describe("Agent Profiles", () => {
  const ALL_ROLES = [
    "architect",
    "coder",
    "reviewer",
    "debugger",
    "analyst",
    "orchestrator",
    "product-manager",
    "security-reviewer",
    "code-reviewer",
    "style-reviewer",
    "qa",
    "compliance",
    "devops",
    "custom",
  ];

  test("accepts all AgentRole enum values", () => {
    db = getTestDb();

    for (const role of ALL_ROLES) {
      expect(() => {
        db.prepare(
          "INSERT INTO agent_profiles (id, display_name, role, model_id) VALUES (?, ?, ?, ?)",
        ).run(`agent-${role}`, `Test ${role}`, role, "test-model");
      }).not.toThrow();
    }

    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM agent_profiles")
      .get() as { cnt: number };
    expect(count.cnt).toBe(ALL_ROLES.length);
  });
});

describe("Session Repository", () => {
  test("create and retrieve session", () => {
    db = getTestDb();
    const repo = new SessionRepository(db);

    const session = repo.create("/test/project");
    expect(session.id).toBeTruthy();
    expect(session.projectPath).toBe("/test/project");

    const retrieved = repo.get(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(session.id);
  });

  test("multiple sessions have unique IDs", () => {
    db = getTestDb();
    const repo = new SessionRepository(db);

    const first = repo.create("/project-1");
    const second = repo.create("/project-2");

    expect(first.id).not.toBe(second.id);
    expect(repo.get(first.id)?.projectPath).toBe("/project-1");
    expect(repo.get(second.id)?.projectPath).toBe("/project-2");
  });
});

describe("Cost Repository", () => {
  test("records cost entries with correct fields", () => {
    db = getTestDb();
    const sessions = new SessionRepository(db);
    const costs = new CostRepository(db);

    const session = sessions.create("/test");

    const entry = costs.record({
      sessionId: session.id,
      timestamp: Math.floor(Date.now() / 1000),
      modelId: "claude-opus-4-6",
      provider: "anthropic",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 0,
      cost: 0.05,
      taskType: "code-gen" as any,
    });

    expect(entry.id).toBeTruthy();
    expect(entry.cost).toBe(0.05);
    expect(entry.modelId).toBe("claude-opus-4-6");

    // Verify it's in the DB
    const row = db
      .prepare("SELECT * FROM cost_records WHERE id = ?")
      .get(entry.id) as any;
    expect(row).not.toBeNull();
    expect(row.cost).toBe(0.05);
  });
});
