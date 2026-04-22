/**
 * Broker integration tests.
 *
 * Each test spins up a real HTTP broker on an ephemeral port with an
 * in-memory SQLite and a stub liveness probe (so fabricated PIDs pass).
 * That keeps tests deterministic and parallel-safe while still exercising
 * the real HTTP wire path end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrokerClient,
  createBroker,
  fingerprintApiKey,
  type Broker,
} from "../index.js";

async function bootBroker(livePids?: Set<number>): Promise<Broker> {
  const alive = livePids ?? new Set<number>();
  const broker = createBroker({
    port: 0, // ephemeral
    dbPath: ":memory:",
    cleanupIntervalMs: 0, // no scheduled reap in tests — reap only at startup
    isPidAlive: (pid) => alive.has(pid),
  });
  await broker.start();
  return broker;
}

function makeClient(
  broker: Broker,
  apiKey: string,
  pid: number,
  overrides: Partial<ConstructorParameters<typeof BrokerClient>[0]> = {},
): BrokerClient {
  return new BrokerClient({
    port: broker.port(),
    apiKey,
    pid,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "",
    heartbeatIntervalMs: 10_000, // won't fire in test
    pollIntervalMs: 10_000, // won't fire in test
    requestTimeoutMs: 2_000,
    ...overrides,
  });
}

let broker: Broker;
let livePids: Set<number>;

beforeEach(async () => {
  livePids = new Set();
  broker = await bootBroker(livePids);
});

afterEach(async () => {
  await broker.stop();
});

describe("broker", () => {
  it("registers a peer and returns an id", async () => {
    livePids.add(101);
    const client = makeClient(broker, "keyA", 101);
    const id = await client.start();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(client.getPeerId()).toBe(id);
    await client.stop();
  });

  it("list-peers returns other same-fingerprint peers and excludes self", async () => {
    livePids.add(201);
    livePids.add(202);
    const a = makeClient(broker, "sharedKey", 201);
    const b = makeClient(broker, "sharedKey", 202);
    await a.start();
    await b.start();

    const aSees = await a.listPeers();
    expect(aSees).toHaveLength(1);
    expect(aSees[0]!.pid).toBe(202);

    const bSees = await b.listPeers();
    expect(bSees).toHaveLength(1);
    expect(bSees[0]!.pid).toBe(201);

    await a.stop();
    await b.stop();
  });

  it("auth fingerprint isolates peers across different API keys", async () => {
    livePids.add(301);
    livePids.add(302);
    const a = makeClient(broker, "keyA", 301);
    const b = makeClient(broker, "keyB", 302);
    await a.start();
    await b.start();

    // Different keys → different fingerprints → mutual invisibility.
    expect(a.getFingerprint()).not.toBe(b.getFingerprint());
    expect(await a.listPeers()).toHaveLength(0);
    expect(await b.listPeers()).toHaveLength(0);

    await a.stop();
    await b.stop();
  });

  it("send-message rejects when target is in a different fingerprint", async () => {
    livePids.add(401);
    livePids.add(402);
    const a = makeClient(broker, "keyA", 401);
    const b = makeClient(broker, "keyB", 402);
    const aId = await a.start();
    const bId = await b.start();

    // A knows B's id only because we're in-process and grabbed it directly.
    // In prod, B would never appear in A's list-peers — this is the "even if
    // you guess the id, the broker still rejects you" backstop.
    void aId;
    await expect(a.sendMessage(bId, "hi")).rejects.toThrow(
      /recipient not reachable/,
    );

    // And vice-versa.
    await expect(b.sendMessage(aId, "hi")).rejects.toThrow(
      /recipient not reachable/,
    );

    await a.stop();
    await b.stop();
  });

  it("delivers messages between same-fingerprint peers in FIFO order", async () => {
    livePids.add(501);
    livePids.add(502);
    const a = makeClient(broker, "sharedKey", 501);
    const b = makeClient(broker, "sharedKey", 502);
    const aId = await a.start();
    const bId = await b.start();

    await a.sendMessage(bId, "first");
    await a.sendMessage(bId, "second");
    await a.sendMessage(bId, "third");

    // Drain via manual poll — the 10s interval won't fire during the test.
    const res = (await (async () => {
      const port = broker.port();
      const pollRes = await fetch(`http://127.0.0.1:${port}/poll-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bId }),
      });
      return pollRes.json() as Promise<{
        messages: Array<{ from_id: string; text: string }>;
      }>;
    })()) as { messages: Array<{ from_id: string; text: string }> };

    expect(res.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(res.messages.every((m) => m.from_id === aId)).toBe(true);

    await a.stop();
    await b.stop();
  });

  it("marks messages delivered so a second poll returns nothing", async () => {
    livePids.add(601);
    livePids.add(602);
    const a = makeClient(broker, "sharedKey", 601);
    const b = makeClient(broker, "sharedKey", 602);
    await a.start();
    const bId = await b.start();
    await a.sendMessage(bId, "hi");

    const port = broker.port();
    const drain = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/poll-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bId }),
      });
      return (await res.json()) as { messages: unknown[] };
    };
    expect((await drain()).messages).toHaveLength(1);
    expect((await drain()).messages).toHaveLength(0);

    await a.stop();
    await b.stop();
  });

  it("re-registration replaces the prior row for a given pid", async () => {
    livePids.add(701);
    const first = makeClient(broker, "keyA", 701);
    const firstId = await first.start();
    await first.stop();

    // Clean exit via unregister — the DB should be empty now.
    livePids.add(701);
    const second = makeClient(broker, "keyA", 701);
    const secondId = await second.start();
    expect(secondId).not.toBe(firstId);
    await second.stop();
  });

  it("list-peers reaps peers whose PID is no longer alive", async () => {
    livePids.add(801);
    livePids.add(802);
    const a = makeClient(broker, "sharedKey", 801);
    const b = makeClient(broker, "sharedKey", 802);
    await a.start();
    await b.start();

    // B's process "dies" — opportunistic cleanup on list-peers should drop it.
    livePids.delete(802);
    const seen = await a.listPeers();
    expect(seen).toHaveLength(0);

    await a.stop();
    // b is already reaped; stop is a no-op for the unregister step.
    await b.stop();
  });

  it("set-summary updates the row and shows up on next list-peers", async () => {
    livePids.add(901);
    livePids.add(902);
    const a = makeClient(broker, "sharedKey", 901);
    const b = makeClient(broker, "sharedKey", 902);
    await a.start();
    await b.start();

    await b.setSummary("debugging the spine");
    const seen = await a.listPeers();
    expect(seen[0]!.summary).toBe("debugging the spine");

    await a.stop();
    await b.stop();
  });

  it("health endpoint returns ok + current peer count", async () => {
    livePids.add(1001);
    const a = makeClient(broker, "keyA", 1001);
    await a.start();
    const health = await a.health();
    expect(health.status).toBe("ok");
    expect(health.peers).toBe(1);
    await a.stop();
  });

  it("fingerprintApiKey is deterministic + 16 hex chars", () => {
    const a = fingerprintApiKey("br_live_xyz");
    const b = fingerprintApiKey("br_live_xyz");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintApiKey("different")).not.toBe(a);
  });
});
