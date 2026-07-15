import { describe, expect, it, vi } from "vitest";
import type { SlackClient } from "../client.js";
import { SlackSocket, type MinimalWebSocket } from "../socket.js";

class FakeWebSocket implements MinimalWebSocket {
  sent: string[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function fakeClient(urls: string[]): SlackClient {
  let i = 0;
  return {
    connectionsOpen: vi.fn(async () => {
      const url = urls[Math.min(i, urls.length - 1)];
      i += 1;
      return { url };
    }),
  } as unknown as SlackClient;
}

describe("SlackSocket", () => {
  it("acks an events_api envelope before onEvent fires", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn((_url: string) => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient(["wss://a.example/socket"]);

    const order: string[] = [];
    const onEvent = vi.fn((payload: unknown, envelopeId: string) => {
      order.push("event");
      expect(payload).toEqual({ type: "message", text: "hi" });
      expect(envelopeId).toBe("env-1");
    });

    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent,
      wsFactory,
    });
    await socket.start();

    const ws = sockets[0];
    ws.triggerOpen();

    const originalSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      order.push("ack");
      originalSend(data);
    };

    ws.triggerMessage(
      JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: { type: "message", text: "hi" },
      }),
    );

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ envelope_id: "env-1" });
    expect(onEvent).toHaveBeenCalledTimes(1);
    // ack must be sent before onEvent fires
    expect(order).toEqual(["ack", "event"]);
  });

  it("ignores hello envelopes", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient(["wss://a.example/socket"]);
    const onEvent = vi.fn();

    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent,
      wsFactory,
    });
    await socket.start();
    sockets[0].triggerMessage(JSON.stringify({ type: "hello" }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("logs and skips malformed frames without throwing", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient(["wss://a.example/socket"]);
    const onEvent = vi.fn();
    const onLog = vi.fn();

    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent,
      wsFactory,
      onLog,
    });
    await socket.start();

    expect(() => sockets[0].triggerMessage("not json{{{")).not.toThrow();
    expect(onLog).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reconnects with a new connectionsOpen call on a disconnect envelope", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient([
      "wss://a.example/socket",
      "wss://b.example/socket",
    ]);

    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent: vi.fn(),
      wsFactory,
      scheduleReconnect: (fn) => fn(), // run immediately in tests
    });
    await socket.start();

    expect(client.connectionsOpen).toHaveBeenCalledTimes(1);

    sockets[0].triggerMessage(
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
    );

    // reconnect happens asynchronously (connect() is async); flush microtasks
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.connectionsOpen).toHaveBeenCalledTimes(2);
    expect(wsFactory).toHaveBeenCalledTimes(2);
  });

  it("reconnects on socket close with exponential backoff, resetting after a proven-good connect (hello)", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient([
      "wss://a.example/socket",
      "wss://b.example/socket",
      "wss://c.example/socket",
    ]);

    const delays: number[] = [];
    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent: vi.fn(),
      wsFactory,
      scheduleReconnect: (fn, delayMs) => {
        delays.push(delayMs);
        fn();
      },
    });
    await socket.start();
    sockets[0].triggerOpen();
    sockets[0].triggerMessage(JSON.stringify({ type: "hello" }));

    // Simulate an unexpected close (not a "disconnect" envelope).
    sockets[0].onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delays[0]).toBe(1000);
    expect(client.connectionsOpen).toHaveBeenCalledTimes(2);

    sockets[1].triggerOpen();
    sockets[1].triggerMessage(JSON.stringify({ type: "hello" })); // proven-good reconnect resets backoff
    sockets[1].onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delays[1]).toBe(1000); // reset, not doubled to 2000
  });

  it("does not reset backoff on a handshake that opens then closes without a hello (reconnect storm guard)", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient([
      "wss://a.example/socket",
      "wss://b.example/socket",
      "wss://c.example/socket",
    ]);

    const delays: number[] = [];
    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent: vi.fn(),
      wsFactory,
      scheduleReconnect: (fn, delayMs) => {
        delays.push(delayMs);
        fn();
      },
    });
    await socket.start();
    sockets[0].triggerOpen();
    sockets[0].onclose?.(); // closes immediately, no "hello" ever received
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delays[0]).toBe(1000);

    sockets[1].triggerOpen();
    sockets[1].onclose?.(); // again, no hello
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delays[1]).toBe(2000); // backoff continues to grow, no storm
  });

  it("closes a live socket before establishing a new one (no orphaned connection)", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient([
      "wss://a.example/socket",
      "wss://b.example/socket",
    ]);

    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent: vi.fn(),
      wsFactory,
    });
    await socket.start();
    sockets[0].triggerOpen();

    // Calling start() again while a connection is already live must not
    // orphan the first socket.
    await (socket as unknown as { connect(): Promise<void> }).connect();

    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it("stop() cancels a pending default-scheduled reconnect timer", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        connectionsOpen: vi.fn(async () => {
          throw new Error("network down");
        }),
      } as unknown as SlackClient;

      const socket = new SlackSocket({
        appToken: "xapp",
        client,
        onEvent: vi.fn(),
      });
      await socket.start();

      expect(client.connectionsOpen).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await socket.stop();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.connectionsOpen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() prevents reconnection", async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory = vi.fn(() => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    });
    const client = fakeClient(["wss://a.example/socket"]);
    const scheduleReconnect = vi.fn((fn: () => void) => fn());

    const socket = new SlackSocket({
      appToken: "xapp",
      client,
      onEvent: vi.fn(),
      wsFactory,
      scheduleReconnect,
    });
    await socket.start();

    await socket.stop();
    expect(sockets[0].closed).toBe(true);

    // A close event firing after stop() must not trigger a reconnect.
    sockets[0].onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleReconnect).not.toHaveBeenCalled();
    expect(client.connectionsOpen).toHaveBeenCalledTimes(1);
  });
});
