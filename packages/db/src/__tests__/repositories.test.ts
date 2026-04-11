import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CostRepository,
  MessageRepository,
  SessionRepository,
  getTestDb,
} from "../index.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("db repositories", () => {
  it("tracks session cost and message counts", () => {
    db = getTestDb();
    const sessions = new SessionRepository(db);

    const session = sessions.create("/tmp/project-a");
    sessions.updateCost(session.id, 1.25);
    sessions.incrementMessages(session.id);
    sessions.incrementMessages(session.id);

    expect(sessions.get(session.id)).toMatchObject({
      id: session.id,
      projectPath: "/tmp/project-a",
      totalCost: 1.25,
      messageCount: 2,
    });
  });

  it("returns the earliest rows when recent lookup shares the same timestamp", () => {
    db = getTestDb();
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);
    const session = sessions.create("/tmp/project-b");

    messages.create(session.id, "user", "first");
    messages.create(session.id, "assistant", "second");
    messages.create(session.id, "user", "third");

    expect(messages.countBySession(session.id)).toBe(3);
    expect(
      messages
        .listBySessionRecent(session.id, 2)
        .map((message) => message.content),
    ).toEqual(["first", "second"]);
  });

  it("aggregates and updates cost records per session", () => {
    db = getTestDb();
    const sessions = new SessionRepository(db);
    const costs = new CostRepository(db);
    const session = sessions.create("/tmp/project-c");
    const now = Math.floor(Date.now() / 1000);

    const first = costs.record({
      timestamp: now - 10,
      sessionId: session.id,
      modelId: "gpt-4.1",
      provider: "openai",
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 0,
      cost: 0.12,
      taskType: "chat",
      projectPath: "/tmp/project-c",
    });
    costs.record({
      timestamp: now,
      sessionId: session.id,
      modelId: "gpt-4.1",
      provider: "openai",
      inputTokens: 60,
      outputTokens: 10,
      cachedTokens: 5,
      cost: 0.2,
      taskType: "chat",
      projectPath: "/tmp/project-c",
    });

    expect(costs.totalCostForSession(session.id)).toBeCloseTo(0.32);
    expect(costs.lastForSession(session.id)?.timestamp).toBe(now);

    costs.updateCost(first.id, 0.5);
    expect(costs.totalCostForSession(session.id)).toBeCloseTo(0.7);
    expect(costs.recentByModel(1)).toEqual([
      {
        modelId: "gpt-4.1",
        totalCost: 0.7,
        requestCount: 2,
      },
    ]);
  });
});
