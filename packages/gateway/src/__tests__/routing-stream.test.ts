/**
 * RoutingEventStream unit tests.
 *
 * `fetch` is stubbed so these don't hit the network. The stub lets us
 * hand-craft SSE frame sequences and control when the stream closes so we
 * can exercise parse paths, reconnection, and gap detection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RoutingEventStream,
  type RoutingStreamEvent,
} from "../routing-stream.js";

/**
 * Build a ReadableStream that emits the given chunks with a small delay
 * between each, then closes.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

/** Wait for `predicate` to return true, polling every 5ms up to `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoutingEventStream", () => {
  it("parses a single routing-decision frame and delivers to subscribers", async () => {
    const body = streamFromChunks([
      "event: routing-decision\n",
      'id: 1\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"r1","task_type":"code","selected_model":"opus-4.7","strategy":"quality","why":"high complexity","cost_estimate_usd":0.12,"cache":"miss","tenant_id":"t1"}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, body });

    const stream = new RoutingEventStream({
      baseUrl: "http://test",
      apiKey: "k",
      maxBackoffMs: 10,
    });

    const seen: RoutingStreamEvent[] = [];
    stream.onEvent((e) => seen.push(e));
    stream.start();

    await waitFor(() => seen.length === 1);
    stream.stop();

    expect(seen[0]!.eventId).toBe(1);
    expect(seen[0]!.decision.selected_model).toBe("opus-4.7");
    expect(seen[0]!.decision.cache).toBe("miss");
    expect(stream.getLastEventId()).toBe(1);
  });

  it("ignores keepalive comments between events", async () => {
    const body = streamFromChunks([
      ":keepalive\n\n",
      'event: routing-decision\nid: 5\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"r","task_type":"x","selected_model":"m","strategy":"price","why":"cheap","cost_estimate_usd":0.001,"cache":"skip","tenant_id":"t"}\n\n',
      ":keepalive\n\n",
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, body });

    const stream = new RoutingEventStream({
      baseUrl: "http://test",
      apiKey: "k",
      maxBackoffMs: 10,
    });
    const seen: RoutingStreamEvent[] = [];
    stream.onEvent((e) => seen.push(e));
    stream.start();

    await waitFor(() => seen.length === 1);
    stream.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.eventId).toBe(5);
  });

  it("sends Last-Event-ID on reconnect after the first stream closes", async () => {
    // First connection: emit event id=3, then EOF.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFromChunks([
        'event: routing-decision\nid: 3\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"r","task_type":"x","selected_model":"m","strategy":"price","why":"","cost_estimate_usd":0,"cache":"skip","tenant_id":"t"}\n\n',
      ]),
    });
    // Second connection: emit event id=4.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFromChunks([
        'event: routing-decision\nid: 4\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"r","task_type":"x","selected_model":"m","strategy":"price","why":"","cost_estimate_usd":0,"cache":"skip","tenant_id":"t"}\n\n',
      ]),
    });

    const stream = new RoutingEventStream({
      baseUrl: "http://test",
      apiKey: "k",
      maxBackoffMs: 10, // fast reconnect so the test stays quick
    });
    const seen: RoutingStreamEvent[] = [];
    stream.onEvent((e) => seen.push(e));
    stream.start();

    await waitFor(() => seen.length === 2, 2000);
    stream.stop();

    expect(seen.map((e) => e.eventId)).toEqual([3, 4]);
    // Second call should carry Last-Event-ID: 3
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondInit = fetchSpy.mock.calls[1]![1] as RequestInit;
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("3");
  });

  it("emits gap notifications when event ids skip forward", async () => {
    const body = streamFromChunks([
      'event: routing-decision\nid: 10\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"a","task_type":"x","selected_model":"m","strategy":"price","why":"","cost_estimate_usd":0,"cache":"skip","tenant_id":"t"}\n\n',
      'event: routing-decision\nid: 20\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"b","task_type":"x","selected_model":"m","strategy":"price","why":"","cost_estimate_usd":0,"cache":"skip","tenant_id":"t"}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, body });

    const stream = new RoutingEventStream({
      baseUrl: "http://test",
      apiKey: "k",
      maxBackoffMs: 10,
    });
    const seenEvents: RoutingStreamEvent[] = [];
    const gaps: number[] = [];
    stream.onEvent((e) => seenEvents.push(e));
    stream.onGap((g) => gaps.push(g));
    stream.start();

    await waitFor(() => seenEvents.length === 2);
    stream.stop();

    expect(seenEvents.map((e) => e.eventId)).toEqual([10, 20]);
    expect(gaps).toEqual([9]); // 20 - 10 - 1 = 9 missing events
  });

  it("tolerates malformed JSON in the data field without crashing", async () => {
    const body = streamFromChunks([
      "event: routing-decision\nid: 1\ndata: {not valid json\n\n",
      'event: routing-decision\nid: 2\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"r","task_type":"x","selected_model":"m","strategy":"price","why":"","cost_estimate_usd":0,"cache":"skip","tenant_id":"t"}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, body });

    const stream = new RoutingEventStream({
      baseUrl: "http://test",
      apiKey: "k",
      maxBackoffMs: 10,
    });
    const seen: RoutingStreamEvent[] = [];
    stream.onEvent((e) => seen.push(e));
    stream.start();

    await waitFor(() => seen.length === 1);
    stream.stop();

    // Malformed event silently skipped; next event still delivered.
    expect(seen.map((e) => e.eventId)).toEqual([2]);
  });

  it("surfaces state transitions idle → connecting → open → closed", async () => {
    const body = streamFromChunks([
      'event: routing-decision\nid: 1\ndata: {"ts":"2026-04-22T19:30:00Z","request_id":"r","task_type":"x","selected_model":"m","strategy":"price","why":"","cost_estimate_usd":0,"cache":"skip","tenant_id":"t"}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, body });

    const stream = new RoutingEventStream({
      baseUrl: "http://test",
      apiKey: "k",
      maxBackoffMs: 5,
    });
    const phases: string[] = [];
    stream.onState((s) => phases.push(s.phase));
    stream.start();

    await waitFor(() => phases.includes("open"));
    stream.stop("test cleanup");

    // onState fires immediately on subscribe with current state, so first
    // entry is the idle state at subscription time.
    expect(phases[0]).toBe("idle");
    expect(phases).toContain("connecting");
    expect(phases).toContain("open");
    expect(phases).toContain("closed");
  });
});
