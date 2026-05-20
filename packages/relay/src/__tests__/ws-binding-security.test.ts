import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startWsBinding, type WsBindingHandle } from "../ws-binding.js";
import type { RelayServer } from "../relay-server.js";
import type { SessionStore } from "../session-store.js";

const handles: WsBindingHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.close();
    } catch {}
  }
  for (const handle of handles.splice(0).reverse()) {
    await handle.close();
  }
});

async function startTestBinding(
  options: Partial<Parameters<typeof startWsBinding>[0]> = {},
): Promise<WsBindingHandle> {
  const handle = await startWsBinding({
    port: 0,
    host: "127.0.0.1",
    server: {} as RelayServer,
    sessions: { removeEndpoint: vi.fn() } as unknown as SessionStore,
    heartbeatIntervalMs: 60_000,
    ...options,
  });
  handles.push(handle);
  return handle;
}

function openSocket(
  handle: WsBindingHandle,
  path = "/v1/operator",
  options = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port()}${path}`, options);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(
  ws: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

describe("ws-binding pre-auth hardening", () => {
  it("closes sockets that do not authenticate before the idle timeout", async () => {
    const handle = await startTestBinding({ unauthenticatedIdleMs: 20 });
    const ws = await openSocket(handle);

    await expect(waitForClose(ws)).resolves.toEqual({
      code: 1008,
      reason: "authentication timeout",
    });
  });

  it("rejects browser origins outside the configured allowlist", async () => {
    const handle = await startTestBinding({
      allowedOrigins: ["https://console.brainstorm.co"],
    });
    const ws = await openSocket(handle, "/v1/operator", {
      headers: { Origin: "https://evil.example" },
    });

    await expect(waitForClose(ws)).resolves.toEqual({
      code: 1008,
      reason: "origin not allowed",
    });
  });

  it("limits unauthenticated payload size before relay parsing", async () => {
    const handle = await startTestBinding({ maxPayloadBytes: 16 });
    const ws = await openSocket(handle);
    ws.send("x".repeat(64));

    await expect(waitForClose(ws)).resolves.toMatchObject({ code: 1009 });
  });

  it("limits concurrent sockets per remote address", async () => {
    const handle = await startTestBinding({ maxConnectionsPerIp: 1 });
    await openSocket(handle);
    const second = await openSocket(handle);

    await expect(waitForClose(second)).resolves.toEqual({
      code: 1013,
      reason: "too many connections",
    });
  });
});
