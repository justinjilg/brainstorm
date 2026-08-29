/**
 * Platform-events intake tests.
 *
 * Before 2026-08-27 this endpoint verified the HMAC signature and then
 * DISCARDED every event — the audit's single largest perception gap. These
 * tests pin the new contract: a verified event is persisted to
 * platform_events (where the KAIROS daemon's perception loop reads it), an
 * invalid signature is rejected without persisting, and a persistence
 * failure is reported as 503 rather than silently acknowledged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BrainstormServer } from "../server";
import { getTestDb, PlatformEventRepository } from "@brainst0rm/db";
import { createSignedEvent } from "@brainst0rm/godmode";
import type Database from "better-sqlite3";

const SECRET = "test-platform-secret";

function mockRes() {
  return {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as import("node:http").ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe("handlePlatformEvents persistence", () => {
  let db: Database.Database;
  let server: BrainstormServer;

  beforeEach(() => {
    // No dedupe-cache reset needed: every createSignedEvent call mints a
    // fresh UUID, so replay protection never collides across tests.
    db = getTestDb();
    process.env.BRAINSTORM_PLATFORM_SECRET = SECRET;
    server = new BrainstormServer(
      {
        db,
        config: {},
        registry: {} as never,
        router: {} as never,
        costTracker: {} as never,
        tools: {} as never,
        version: "test",
      } as never,
      { jwtSecret: "test-secret" },
    );
  });

  afterEach(() => {
    delete process.env.BRAINSTORM_PLATFORM_SECRET;
    db.close();
    vi.restoreAllMocks();
  });

  it("persists a verified event for the daemon's perception loop", async () => {
    const event = createSignedEvent(
      "msp.alert.created",
      "tenant-1",
      "msp",
      { message: "Disk failure predicted on host-7", host: "host-7" },
      SECRET,
    );
    vi.spyOn(
      server as never as { readBody: () => unknown },
      "readBody",
    ).mockResolvedValue(event as never);
    const res = mockRes();

    await (
      server as never as {
        handlePlatformEvents: (req: unknown, res: unknown) => Promise<void>;
      }
    ).handlePlatformEvents({}, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());

    const stored = new PlatformEventRepository(db).listUnconsumed();
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("msp");
    expect(stored[0].eventType).toBe("msp.alert.created");
    expect(stored[0].summary).toBe("Disk failure predicted on host-7");
    expect(stored[0].payload).toMatchObject({
      eventId: event.id,
      tenantId: "tenant-1",
    });
  });

  it("rejects an invalid signature without persisting anything", async () => {
    const event = createSignedEvent(
      "msp.alert.created",
      "t",
      "msp",
      {},
      SECRET,
    );
    event.signature = "00".repeat(32);
    vi.spyOn(
      server as never as { readBody: () => unknown },
      "readBody",
    ).mockResolvedValue(event as never);
    const res = mockRes();

    await (
      server as never as {
        handlePlatformEvents: (req: unknown, res: unknown) => Promise<void>;
      }
    ).handlePlatformEvents({}, res);

    expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    expect(new PlatformEventRepository(db).listUnconsumed()).toHaveLength(0);
  });

  it("returns 503 when the event verifies but cannot be persisted", async () => {
    const event = createSignedEvent("vm.node.down", "t", "vm", {}, SECRET);
    vi.spyOn(
      server as never as { readBody: () => unknown },
      "readBody",
    ).mockResolvedValue(event as never);
    // Simulate a dead store: closing the db makes every statement throw.
    db.close();
    const res = mockRes();

    await (
      server as never as {
        handlePlatformEvents: (req: unknown, res: unknown) => Promise<void>;
      }
    ).handlePlatformEvents({}, res);

    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
    // Re-open for afterEach's close.
    db = getTestDb();
  });
});
