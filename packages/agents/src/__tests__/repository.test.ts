import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "@brainst0rm/shared";
import { AgentRepository } from "../repository.js";

let db: Database.Database;

function createRepository() {
  db = new Database(":memory:");
  db.exec(`
        CREATE TABLE agent_profiles (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            model_id TEXT NOT NULL,
            system_prompt TEXT,
            allowed_tools TEXT NOT NULL DEFAULT '"all"',
            output_format TEXT,
            budget_per_workflow REAL,
            budget_daily REAL,
            exhaustion_action TEXT NOT NULL DEFAULT 'downgrade',
            downgrade_model_id TEXT,
            confidence_threshold REAL NOT NULL DEFAULT 0.7,
            max_steps INTEGER NOT NULL DEFAULT 10,
            fallback_chain TEXT NOT NULL DEFAULT '[]',
            guardrails TEXT NOT NULL DEFAULT '{}',
            lifecycle TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
    `);
  return new AgentRepository(db);
}

function createProfile(
  overrides: Partial<Omit<AgentProfile, "createdAt" | "updatedAt">> = {},
): Omit<AgentProfile, "createdAt" | "updatedAt"> {
  return {
    id: "agent-1",
    displayName: "Code Agent",
    role: "coder",
    description: "Writes implementation code",
    modelId: "openai/gpt-5.4",
    systemPrompt: "Ship reliable code.",
    allowedTools: ["file_read", "file_edit"],
    outputFormat: "markdown",
    budget: {
      perWorkflow: 25,
      daily: 100,
      exhaustionAction: "downgrade",
      downgradeModelId: "openai/gpt-5-mini",
    },
    confidenceThreshold: 0.82,
    maxSteps: 12,
    fallbackChain: ["openai/gpt-5-mini", "auto:quality"],
    guardrails: {
      pii: true,
      topicRestriction: "engineering",
    },
    lifecycle: "active",
    ...overrides,
  };
}

afterEach(() => {
  if (db) {
    db.close();
  }
});

describe("AgentRepository", () => {
  it("inserts and retrieves an agent profile", () => {
    const repo = createRepository();
    const input = createProfile();

    const created = repo.create(input);
    const retrieved = repo.get(input.id);

    expect(created.id).toBe(input.id);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(retrieved).toEqual(created);
    expect(retrieved?.allowedTools).toEqual(["file_read", "file_edit"]);
    expect(retrieved?.budget.downgradeModelId).toBe("openai/gpt-5-mini");
  });

  it("lists all active profiles and excludes suspended ones", () => {
    const repo = createRepository();

    const first = repo.create(
      createProfile({ id: "agent-1", displayName: "First Agent" }),
    );
    const second = repo.create(
      createProfile({
        id: "agent-2",
        displayName: "Second Agent",
        role: "reviewer",
      }),
    );
    repo.create(
      createProfile({
        id: "agent-3",
        displayName: "Suspended Agent",
        lifecycle: "suspended",
      }),
    );

    const profiles = repo.list();

    expect(profiles).toHaveLength(2);
    expect(profiles.map((profile) => profile.id).sort()).toEqual([
      first.id,
      second.id,
    ]);
    expect(profiles.every((profile) => profile.lifecycle === "active")).toBe(
      true,
    );
  });

  it("updates an existing profile and merges nested settings", () => {
    const repo = createRepository();
    repo.create(createProfile());

    const updated = repo.update("agent-1", {
      displayName: "Updated Code Agent",
      allowedTools: "all",
      budget: {
        daily: 250,
        exhaustionAction: "stop",
      },
      guardrails: {
        topicRestriction: "security",
      },
      lifecycle: "suspended",
    });

    expect(updated).not.toBeNull();
    expect(updated?.displayName).toBe("Updated Code Agent");
    expect(updated?.allowedTools).toBe("all");
    expect(updated?.budget).toEqual({
      perWorkflow: 25,
      daily: 250,
      exhaustionAction: "stop",
      downgradeModelId: "openai/gpt-5-mini",
    });
    expect(updated?.guardrails).toEqual({
      pii: true,
      topicRestriction: "security",
    });
    expect(updated?.lifecycle).toBe("suspended");
    expect(repo.get("agent-1")).toEqual(updated);
  });

  it("deletes a profile and reports whether it existed", () => {
    const repo = createRepository();
    repo.create(createProfile());

    expect(repo.delete("agent-1")).toBe(true);
    expect(repo.get("agent-1")).toBeNull();
    expect(repo.delete("agent-1")).toBe(false);
  });

  it("queries active profiles by role", () => {
    const repo = createRepository();
    repo.create(
      createProfile({ id: "coder-active", role: "coder", lifecycle: "active" }),
    );
    repo.create(
      createProfile({
        id: "coder-suspended",
        role: "coder",
        lifecycle: "suspended",
      }),
    );
    repo.create(
      createProfile({
        id: "reviewer-active",
        role: "reviewer",
        lifecycle: "active",
      }),
    );

    const coders = repo.listByRole("coder");

    expect(coders).toHaveLength(1);
    expect(coders[0]?.id).toBe("coder-active");
    expect(coders[0]?.role).toBe("coder");
  });

  it("returns null when a profile is missing", () => {
    const repo = createRepository();

    expect(repo.get("missing-agent")).toBeNull();
    expect(repo.update("missing-agent", { displayName: "Nope" })).toBeNull();
  });
});
