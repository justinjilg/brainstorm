import { describe, it, expect, beforeEach } from "vitest";
import { SlackAdapter, type SlackAdapterOptions } from "./adapter.js";
import type { InboundMessage, OutboundSink } from "../types.js";
import type { SlackSocketOptions } from "./socket.js";

// ── Fakes ──────────────────────────────────────────────────────────

type PostCall = { channel: string; text: string; threadTs?: string };
type UpdateCall = { channel: string; ts: string; text: string };

class FakeClient {
  postCalls: PostCall[] = [];
  updateCalls: UpdateCall[] = [];
  private tsSeq = 0;

  async postMessage(channel: string, text: string, threadTs?: string) {
    this.postCalls.push({ channel, text, threadTs });
    return { ts: `ph-${++this.tsSeq}` };
  }
  async update(channel: string, ts: string, text: string) {
    this.updateCalls.push({ channel, ts, text });
  }
  async authTest() {
    return { userId: "UBOT", teamId: "TEAM" };
  }
}

class FakeSocket {
  started = false;
  stopped = false;
  readonly onEvent: SlackSocketOptions["onEvent"];
  constructor(opts: SlackSocketOptions) {
    this.onEvent = opts.onEvent;
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
}

class FakeCoordinator {
  calls: Array<{ msg: InboundMessage; sink: OutboundSink }> = [];
  reject = false;
  async handle(msg: InboundMessage, sink: OutboundSink): Promise<void> {
    this.calls.push({ msg, sink });
    if (this.reject) throw new Error("boom internal stack trace");
  }
}

// ── Harness ────────────────────────────────────────────────────────

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Built {
  adapter: SlackAdapter;
  client: FakeClient;
  socket: FakeSocket;
  coordinator: FakeCoordinator;
  emit: (payload: unknown, envelopeId: string) => void;
  logs: Array<{ msg: string; err?: unknown }>;
}

async function build(
  overrides: Partial<SlackAdapterOptions> = {},
): Promise<Built> {
  const client = new FakeClient();
  let socket!: FakeSocket;
  const coordinator = new FakeCoordinator();
  const logs: Array<{ msg: string; err?: unknown }> = [];

  const adapter = new SlackAdapter({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    authority: "read-only",
    coordinator,
    clientFactory: () => client,
    socketFactory: (opts) => {
      socket = new FakeSocket(opts);
      return socket;
    },
    onLog: (msg, err) => logs.push({ msg, err }),
    ...overrides,
  });

  await adapter.start();
  return {
    adapter,
    client,
    socket,
    coordinator,
    emit: (payload, envelopeId) => socket.onEvent(payload, envelopeId),
    logs,
  };
}

function dmPayload(
  over: Record<string, unknown> = {},
  eventId = "Ev1",
): unknown {
  return {
    team_id: "TEAM2",
    event_id: eventId,
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      text: "hello",
      ts: "111.1",
      ...over,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("SlackAdapter", () => {
  it("learns own identity and starts the socket on start()", async () => {
    const { socket } = await build();
    expect(socket.started).toBe(true);
  });

  it("maps a DM message to the correct InboundMessage", async () => {
    const { emit, coordinator } = await build();
    const payload = dmPayload();
    emit(payload, "env-1");
    await flush();

    expect(coordinator.calls).toHaveLength(1);
    const { msg } = coordinator.calls[0];
    expect(msg).toMatchObject({
      channelType: "slack",
      teamId: "TEAM2",
      channelId: "D1",
      threadKey: "D1", // im top-level: threadKey === channel
      userId: "U1",
      text: "hello",
    });
    expect(msg.raw).toBe((payload as any).event);
  });

  it("accepts app_mention and strips the leading <@BOTID> mention", async () => {
    const { emit, coordinator } = await build();
    emit(
      {
        team_id: "TEAM2",
        event_id: "Ev-m",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@UBOT>   do the thing",
          ts: "222.2",
        },
      },
      "env-m",
    );
    await flush();

    expect(coordinator.calls).toHaveLength(1);
    const { msg } = coordinator.calls[0];
    expect(msg.text).toBe("do the thing");
    expect(msg.channelId).toBe("C1");
    expect(msg.threadKey).toBe("222.2"); // non-im, no thread_ts → event.ts
  });

  it("maps a threaded reply's threadKey to thread_ts", async () => {
    const { emit, coordinator } = await build();
    emit(dmPayload({ thread_ts: "999.9" }), "env-t");
    await flush();
    expect(coordinator.calls[0].msg.threadKey).toBe("999.9");
  });

  it("drops bot messages, self messages, and non-DM non-mention events", async () => {
    const { emit, coordinator } = await build();
    emit(dmPayload({ bot_id: "B123" }), "e1");
    emit(dmPayload({ user: "UBOT" }), "e2"); // self
    emit(dmPayload({ subtype: "message_changed" }), "e3"); // edited/subtype
    emit(dmPayload({ channel_type: "channel" }), "e4"); // channel message, not mention
    await flush();
    expect(coordinator.calls).toHaveLength(0);
  });

  it("enforces the user allowlist when non-empty", async () => {
    const { emit, coordinator } = await build({ allowedUsers: ["U9"] });
    emit(dmPayload({ user: "U1" }, "Ev-a"), "e1"); // not allowed
    await flush();
    expect(coordinator.calls).toHaveLength(0);

    emit(dmPayload({ user: "U9" }, "Ev-b"), "e2"); // allowed
    await flush();
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0].msg.userId).toBe("U9");
  });

  it("enforces the channel allowlist when non-empty", async () => {
    const { emit, coordinator } = await build({ allowedChannels: ["C9"] });
    emit(dmPayload({ channel: "D1" }, "Ev-a"), "e1"); // not allowed
    await flush();
    expect(coordinator.calls).toHaveLength(0);

    emit(dmPayload({ channel: "C9" }, "Ev-b"), "e2"); // allowed
    await flush();
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0].msg.channelId).toBe("C9");
  });

  it("dedupes on envelope id", async () => {
    const { emit, coordinator } = await build();
    emit(dmPayload({}), "dup-env");
    emit(dmPayload({}), "dup-env");
    await flush();
    expect(coordinator.calls).toHaveLength(1);
  });

  it("dedupes on event id even across different envelopes", async () => {
    const { emit, coordinator } = await build();
    emit(dmPayload(), "env-a"); // event_id Ev1
    emit(dmPayload(), "env-b"); // same event_id Ev1, new envelope
    await flush();
    expect(coordinator.calls).toHaveLength(1);
  });

  it("sink placeholder → finalize posts then updates with mrkdwn-converted text", async () => {
    const { emit, coordinator, client } = await build();
    emit(dmPayload(), "env-sink");
    await flush();

    const { msg, sink } = coordinator.calls[0];
    const placeholderId = await sink.postPlaceholder(msg);

    expect(client.postCalls).toHaveLength(1);
    expect(client.postCalls[0].channel).toBe("D1");
    expect(client.postCalls[0].text).toContain("working");
    // im top-level → no thread_ts
    expect(client.postCalls[0].threadTs).toBeUndefined();
    expect(placeholderId).toBe("ph-1");

    await sink.finalize(
      msg,
      placeholderId,
      "**bold** and a [link](https://x.io)",
      {
        cost: 0.0123,
        toolCalls: ["read_file", "shell"],
      },
    );

    expect(client.updateCalls).toHaveLength(1);
    const upd = client.updateCalls[0];
    expect(upd.channel).toBe("D1");
    expect(upd.ts).toBe("ph-1");
    expect(upd.text).toContain("*bold*"); // ** → *
    expect(upd.text).toContain("<https://x.io|link>"); // link conversion
    expect(upd.text).toContain("2 tool calls"); // footer count
    expect(upd.text).toContain("$0.0123"); // footer cost
  });

  it("placeholder in a thread carries thread_ts", async () => {
    const { emit, coordinator, client } = await build();
    emit(dmPayload({ thread_ts: "999.9" }), "env-th");
    await flush();
    const { msg, sink } = coordinator.calls[0];
    await sink.postPlaceholder(msg);
    expect(client.postCalls[0].threadTs).toBe("999.9");
  });

  it("postError updates the placeholder when present, without leaking a stack", async () => {
    const { emit, coordinator, client } = await build();
    emit(dmPayload(), "env-err");
    await flush();
    const { msg, sink } = coordinator.calls[0];
    await sink.postError(
      msg,
      "ph-existing",
      "First line\n at internal.stack (foo.ts:1)",
    );
    expect(client.updateCalls).toHaveLength(1);
    expect(client.updateCalls[0].text).toContain("First line");
    expect(client.updateCalls[0].text).not.toContain("internal.stack");
  });

  it("postError posts a new message when there is no placeholder", async () => {
    const { emit, coordinator, client } = await build();
    emit(dmPayload({ thread_ts: "999.9" }), "env-err2");
    await flush();
    const { msg, sink } = coordinator.calls[0];
    await sink.postError(msg, null, "kaboom");
    expect(client.postCalls).toHaveLength(1);
    expect(client.postCalls[0].text).toContain("kaboom");
    expect(client.postCalls[0].threadTs).toBe("999.9");
  });

  it("coordinator rejection does not crash the event handler", async () => {
    const { emit, coordinator, logs } = await build();
    coordinator.reject = true;
    expect(() => emit(dmPayload(), "env-reject")).not.toThrow();
    await flush();
    expect(coordinator.calls).toHaveLength(1);
    // rejection was caught and routed to onLog, not thrown
    expect(logs.some((l) => /coordinator\.handle failed/.test(l.msg))).toBe(
      true,
    );
  });

  it("stop() stops the socket", async () => {
    const { adapter, socket } = await build();
    await adapter.stop();
    expect(socket.stopped).toBe(true);
  });
});
