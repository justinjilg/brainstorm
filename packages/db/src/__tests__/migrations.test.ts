import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { getTestDb } from "../index.js";

let db: Database.Database | undefined;

function listUserTables(database: Database.Database): string[] {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("db migrations", () => {
  test("getTestDb applies migrations on a fresh in-memory database", () => {
    db = getTestDb();

    const tables = listUserTables(db);

    expect(tables).toEqual(
      expect.arrayContaining([
        "_migrations",
        "sessions",
        "messages",
        "cost_records",
        "projects",
        "conversations",
        "workflow_runs",
      ]),
    );
    // +3 for orgs, team_members, compliance_events (migrations 031-033)
    expect(tables).toHaveLength(31);
    expect(tables).toContain("sync_queue");
    expect(tables).toContain("orgs");
    expect(tables).toContain("team_members");
    expect(tables).toContain("compliance_events");
  });

  test("migration ledger records each migration exactly once", () => {
    db = getTestDb();

    const migrations = db
      .prepare("SELECT name FROM _migrations ORDER BY id")
      .all() as Array<{ name: string }>;

    expect(migrations).toHaveLength(33);
    expect(migrations[0]?.name).toBe("001_sessions");
    expect(migrations.at(-1)?.name).toBe("033_compliance_events");
    expect(new Set(migrations.map((migration) => migration.name)).size).toBe(
      33,
    );
  });

  test("migration ledger stays unchanged when data is inserted after setup", () => {
    db = getTestDb();

    const beforeCount = (
      db.prepare("SELECT COUNT(*) AS count FROM _migrations").get() as {
        count: number;
      }
    ).count;

    db.prepare(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())",
    ).run("project-1", "Project 1", "/tmp/project-1");
    db.prepare(
      "INSERT INTO sessions (id, project_path, created_at, updated_at, project_id) VALUES (?, ?, unixepoch(), unixepoch(), ?)",
    ).run("session-1", "/tmp/project-1", "project-1");

    const afterCount = (
      db.prepare("SELECT COUNT(*) AS count FROM _migrations").get() as {
        count: number;
      }
    ).count;
    const tables = listUserTables(db);

    expect(afterCount).toBe(beforeCount);
    expect(tables).toContain("sessions");
    expect(tables).toContain("projects");
  });

  test("sessions table includes migrated columns needed by daemon and conversation features", () => {
    db = getTestDb();

    const columns = db.pragma("table_info(sessions)") as Array<{
      name: string;
    }>;
    const names = columns.map((column) => column.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "is_daemon",
        "tick_count",
        "last_tick_at",
        "is_paused",
        "tick_interval_ms",
        "conversation_id",
      ]),
    );
  });

  test("getTestDb returns an isolated clean in-memory database each time", () => {
    db = getTestDb();
    db.prepare(
      "INSERT INTO sessions (id, project_path, created_at, updated_at) VALUES (?, ?, unixepoch(), unixepoch())",
    ).run("session-1", "/tmp/project");

    const dirtyCount = (
      db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
        count: number;
      }
    ).count;
    expect(dirtyCount).toBe(1);

    db.close();
    db = getTestDb();

    const cleanCount = (
      db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
        count: number;
      }
    ).count;
    const filename = (
      db.prepare("PRAGMA database_list").all() as Array<{ file: string }>
    )[0]?.file;

    expect(cleanCount).toBe(0);
    expect(filename).toBe("");
  });
});
