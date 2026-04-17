/**
 * ProjectRepository + ProjectManager tests.
 *
 * Uses an in-memory SQLite DB via getTestDb() so nothing touches
 * ~/.brainstorm. A unique tmp directory is used for filesystem-backed
 * register()/autoDetect() paths since they resolve absolute paths and
 * check existsSync().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getTestDb } from "@brainst0rm/db";
import { ProjectRepository, ProjectMemoryRepository } from "../repository.js";
import { ProjectManager } from "../manager.js";

let db: Database.Database;
let tmpRoot: string;

beforeEach(() => {
  db = getTestDb();
  tmpRoot = join(tmpdir(), `brainstorm-projects-test-${randomUUID()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  db.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("ProjectRepository", () => {
  it("creates a project and round-trips fields including knowledgeFiles JSON", () => {
    const repo = new ProjectRepository(db);
    const p = repo.create({
      name: "alpha",
      path: "/tmp/alpha",
      description: "first",
      customInstructions: "be terse",
      knowledgeFiles: ["docs/a.md", "docs/b.md"],
      budgetDaily: 2.5,
      budgetMonthly: 50,
    });

    expect(p.id).toMatch(/[0-9a-f-]{36}/);
    expect(p.name).toBe("alpha");
    expect(p.path).toBe("/tmp/alpha");
    expect(p.description).toBe("first");
    expect(p.customInstructions).toBe("be terse");
    expect(p.knowledgeFiles).toEqual(["docs/a.md", "docs/b.md"]);
    expect(p.budgetDaily).toBe(2.5);
    expect(p.budgetMonthly).toBe(50);
    expect(p.isActive).toBe(true);

    const fetched = repo.getById(p.id);
    expect(fetched).toEqual(p);
  });

  it("looks up projects by name and path, and hides inactive from name/path lookups", () => {
    const repo = new ProjectRepository(db);
    const p = repo.create({ name: "beta", path: "/tmp/beta" });

    expect(repo.getByName("beta")?.id).toBe(p.id);
    expect(repo.getByPath("/tmp/beta")?.id).toBe(p.id);

    repo.delete(p.id); // soft-delete
    expect(repo.getByName("beta")).toBeUndefined();
    expect(repo.getByPath("/tmp/beta")).toBeUndefined();

    // But list(includeInactive=true) should still find it
    const all = repo.list(true);
    expect(all.find((x) => x.id === p.id)?.isActive).toBe(false);
    expect(repo.list(false).find((x) => x.id === p.id)).toBeUndefined();
  });

  it("update() modifies only provided fields and refreshes updated_at", async () => {
    const repo = new ProjectRepository(db);
    const p = repo.create({ name: "gamma", path: "/tmp/gamma" });
    const originalUpdated = p.updatedAt;

    // Wait >=1s so the unix-second timestamp actually moves
    await new Promise((r) => setTimeout(r, 1100));

    const updated = repo.update(p.id, {
      description: "new desc",
      budgetDaily: 10,
    });
    expect(updated?.description).toBe("new desc");
    expect(updated?.budgetDaily).toBe(10);
    expect(updated?.name).toBe("gamma"); // untouched
    expect(updated!.updatedAt).toBeGreaterThan(originalUpdated);
  });

  it("getCost() sums cost_records for a project path within a time window", () => {
    const repo = new ProjectRepository(db);
    repo.create({ name: "delta", path: "/tmp/delta" });

    // Insert some cost records directly. cost_records requires a session row
    // because of the FK with ON DELETE CASCADE.
    const sessionId = "s-1";
    db.prepare("INSERT INTO sessions (id, project_path) VALUES (?, ?)").run(
      sessionId,
      "/tmp/delta",
    );

    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare(
      `INSERT INTO cost_records
       (id, timestamp, session_id, model_id, provider, input_tokens, output_tokens, cost, task_type, project_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "c1",
      now - 10,
      sessionId,
      "m",
      "p",
      0,
      0,
      1.25,
      "general",
      "/tmp/delta",
    );
    insert.run(
      "c2",
      now - 5,
      sessionId,
      "m",
      "p",
      0,
      0,
      0.75,
      "general",
      "/tmp/delta",
    );
    // Old record outside window
    insert.run(
      "c3",
      now - 10_000,
      sessionId,
      "m",
      "p",
      0,
      0,
      99,
      "general",
      "/tmp/delta",
    );
    // Different project, must not be counted
    insert.run(
      "c4",
      now - 1,
      sessionId,
      "m",
      "p",
      0,
      0,
      5,
      "general",
      "/tmp/other",
    );

    const total = repo.getCost("/tmp/delta", now - 100);
    expect(total).toBeCloseTo(2.0);
  });
});

describe("ProjectMemoryRepository", () => {
  it("set() upserts by (project_id, key) and list filters by category", () => {
    const repo = new ProjectRepository(db);
    const mem = new ProjectMemoryRepository(db);
    const p = repo.create({ name: "mem-proj", path: "/tmp/mem-proj" });

    mem.set(p.id, "style", "spaces not tabs", "convention");
    mem.set(p.id, "style", "2-space indent", "convention"); // upsert
    mem.set(p.id, "flake", "CI timezone bug", "warning");

    const all = mem.list(p.id);
    expect(all).toHaveLength(2);

    const style = mem.get(p.id, "style");
    expect(style?.value).toBe("2-space indent");

    const warnings = mem.list(p.id, "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].key).toBe("flake");

    mem.remove(p.id, "flake");
    expect(mem.get(p.id, "flake")).toBeUndefined();
  });
});

describe("ProjectManager", () => {
  it("register() resolves the path, dedupes by path, and rejects missing directories", () => {
    const mgr = new ProjectManager(db);
    const dir = join(tmpRoot, "proj-one");
    mkdirSync(dir);

    const p1 = mgr.register(dir, "proj-one");
    expect(p1.path).toBe(dir);
    expect(p1.name).toBe("proj-one");

    // Registering the same path again is idempotent (returns existing)
    const p2 = mgr.register(dir, "different-name-ignored");
    expect(p2.id).toBe(p1.id);

    // Missing directory throws
    expect(() => mgr.register(join(tmpRoot, "does-not-exist"))).toThrow(
      /Path does not exist/,
    );
  });

  it("register() rejects duplicate names at different paths", () => {
    const mgr = new ProjectManager(db);
    const dirA = join(tmpRoot, "a");
    const dirB = join(tmpRoot, "b");
    mkdirSync(dirA);
    mkdirSync(dirB);

    mgr.register(dirA, "samename");
    expect(() => mgr.register(dirB, "samename")).toThrow(/already exists/);
  });

  it("switch() / getActive() / activateByPath() track the active project", () => {
    const mgr = new ProjectManager(db);
    const dir = join(tmpRoot, "switchy");
    mkdirSync(dir);
    const p = mgr.register(dir, "switchy");

    expect(mgr.getActive()).toBeNull();
    mgr.switch("switchy");
    expect(mgr.getActive()?.id).toBe(p.id);

    expect(() => mgr.switch("nope")).toThrow(/not found/);

    // Soft-delete then switching should refuse
    mgr.projects.delete(p.id);
    expect(() => mgr.switch("switchy")).toThrow();

    // activateByPath returns null for unknown path, the project for known
    expect(mgr.activateByPath(join(tmpRoot, "nowhere"))).toBeNull();
  });

  it("checkBudget() flags over-limit daily spend and passes when under", () => {
    const mgr = new ProjectManager(db);
    const dir = join(tmpRoot, "budgeted");
    mkdirSync(dir);
    const p = mgr.register(dir, "budgeted", { budgetDaily: 1.0 });

    // No spend yet -> within budget
    let check = mgr.checkBudget(p.id);
    expect(check.withinBudget).toBe(true);

    // Insert a cost record that blows the daily budget
    const sessionId = "s-budget";
    db.prepare("INSERT INTO sessions (id, project_path) VALUES (?, ?)").run(
      sessionId,
      p.path,
    );
    db.prepare(
      `INSERT INTO cost_records
       (id, timestamp, session_id, model_id, provider, input_tokens, output_tokens, cost, task_type, project_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "c-over",
      Math.floor(Date.now() / 1000),
      sessionId,
      "m",
      "p",
      0,
      0,
      2.5,
      "general",
      p.path,
    );

    check = mgr.checkBudget(p.id);
    expect(check.withinBudget).toBe(false);
    expect(check.remaining).toBe(0);
    expect(check.message).toMatch(/Daily budget exceeded/);
  });

  it("checkBudget() returns remaining daily spend when monthly is unset", () => {
    // Before the fix, this returned { remaining: null } — the daily branch
    // fell through without surfacing the remaining value, so any caller
    // displaying headroom got null and nothing to show.
    const mgr = new ProjectManager(db);
    const dir = join(tmpRoot, "daily-only");
    mkdirSync(dir);
    const p = mgr.register(dir, "daily-only", { budgetDaily: 3.0 });

    // Insert a small cost well under the $3 daily cap.
    const sessionId = "s-daily-only";
    db.prepare("INSERT INTO sessions (id, project_path) VALUES (?, ?)").run(
      sessionId,
      p.path,
    );
    db.prepare(
      `INSERT INTO cost_records
       (id, timestamp, session_id, model_id, provider, input_tokens, output_tokens, cost, task_type, project_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "c-small",
      Math.floor(Date.now() / 1000),
      sessionId,
      "m",
      "p",
      0,
      0,
      0.75,
      "general",
      p.path,
    );

    const check = mgr.checkBudget(p.id);
    expect(check.withinBudget).toBe(true);
    expect(check.remaining).toBeCloseTo(2.25, 5);
  });

  it("autoDetect() skips bare dirs and auto-registers dirs with brainstorm.toml", () => {
    const mgr = new ProjectManager(db);
    const bare = join(tmpRoot, "bare");
    const configured = join(tmpRoot, "configured");
    mkdirSync(bare);
    mkdirSync(configured);
    writeFileSync(join(configured, "brainstorm.toml"), "");

    expect(mgr.autoDetect(bare)).toBeNull();

    const p = mgr.autoDetect(configured);
    expect(p).not.toBeNull();
    expect(p?.path).toBe(configured);
    expect(mgr.getActive()?.id).toBe(p?.id);
  });
});
