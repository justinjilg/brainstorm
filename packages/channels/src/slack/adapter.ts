/**
 * SlackAdapter — transport-only Slack channel adapter (Socket Mode).
 *
 * Receives platform events over a SlackSocket, filters them (DMs +
 * app_mentions, no bots, no self, optional user/channel allowlists),
 * dedupes on envelope id and event id, maps to an InboundMessage, and
 * fire-and-forgets to the IntakeCoordinator — which is the ONLY thing that
 * touches the agent loop. Posting placeholders/results back to Slack goes
 * through an internal OutboundSink built over SlackClient.
 *
 * handleEvent must return fast: the socket has already ACKed the envelope,
 * so all agent work happens off the event-handler path.
 */

import { createLogger } from "@brainst0rm/shared";
import type {
  ChannelAdapter,
  ChannelAuthority,
  InboundMessage,
  OutboundSink,
} from "../types.js";
import { markdownToMrkdwn, truncateForSlack } from "../render.js";
import { SlackClient, type SlackClientOptions } from "./client.js";
import { SlackSocket, type SlackSocketOptions } from "./socket.js";

const log = createLogger("slack-adapter");

/** Structural view of the coordinator — the adapter only needs `handle`. */
interface CoordinatorLike {
  handle(msg: InboundMessage, sink: OutboundSink): Promise<void>;
}

/** Minimal client surface the adapter's sink depends on. */
type SlackClientLike = Pick<SlackClient, "postMessage" | "update" | "authTest">;

/** Minimal socket surface the adapter drives. */
interface SlackSocketLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
  authority: ChannelAuthority;
  /** When non-empty, only these channel ids are accepted. */
  allowedChannels?: string[];
  /** When non-empty, only these user ids are accepted. */
  allowedUsers?: string[];
  coordinator: CoordinatorLike;
  clientFactory?: (
    botToken: string,
    opts?: SlackClientOptions,
  ) => SlackClientLike;
  socketFactory?: (opts: SlackSocketOptions) => SlackSocketLike;
  onLog?: (msg: string, err?: unknown) => void;
}

/** Loose typing of the Slack events_api payload the socket forwards. */
interface SlackEventEnvelopePayload {
  team_id?: string;
  event_id?: string;
  event?: SlackInnerEvent;
  [key: string]: unknown;
}

interface SlackInnerEvent {
  type?: string;
  channel_type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  event_id?: string;
  [key: string]: unknown;
}

/** Insertion-order LRU cap for the dedupe cache (mirrors github-webhook). */
const DEDUPE_CACHE_CAP = 1000;

export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack";

  private readonly opts: SlackAdapterOptions;
  private client: SlackClientLike | null = null;
  private socket: SlackSocketLike | null = null;
  private sink: OutboundSink | null = null;

  private selfUserId: string | null = null;
  private teamId: string | null = null;
  private started = false;

  /** Dedupe cache — keys are prefixed envelope ids and event ids. */
  private readonly seen = new Map<string, number>();

  constructor(opts: SlackAdapterOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // Idempotency guard: a supervisor retrying start() after a partial
    // failure must not stack a second live socket on top of the first
    // (which would double-deliver every event to the coordinator).
    if (this.started) return;
    this.started = true;

    const client = this.opts.clientFactory
      ? this.opts.clientFactory(this.opts.botToken)
      : new SlackClient(this.opts.botToken);
    this.client = client;

    // Learn our own identity so we can drop self-authored messages.
    const identity = await client.authTest();
    this.selfUserId = identity.userId;
    this.teamId = identity.teamId;

    this.sink = this.buildSink(client);

    const socketOpts: SlackSocketOptions = {
      appToken: this.opts.appToken,
      client: client as unknown as SlackClient,
      onEvent: this.handleEvent,
    };
    this.socket = this.opts.socketFactory
      ? this.opts.socketFactory(socketOpts)
      : new SlackSocket(socketOpts);

    await this.socket.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.socket) await this.socket.stop();
  }

  /**
   * Socket event handler. MUST be synchronous and fast — the socket already
   * ACKed the envelope. All real work is fire-and-forget to the coordinator.
   * Arrow property so `this` is bound when passed as `onEvent`.
   */
  private handleEvent = (payload: unknown, envelopeId: string): void => {
    try {
      const p = (payload ?? {}) as SlackEventEnvelopePayload;
      const event = p.event;
      if (!event || typeof event !== "object") return;

      const type = event.type;
      const isDm =
        type === "message" &&
        event.channel_type === "im" &&
        event.subtype === undefined;
      const isMention = type === "app_mention";
      if (!isDm && !isMention) return;

      // Never react to bots or to ourselves.
      if (event.bot_id) return;
      if (!event.user || event.user === this.selfUserId) return;

      // Allowlists (only enforced when non-empty).
      const { allowedUsers, allowedChannels } = this.opts;
      if (
        allowedUsers &&
        allowedUsers.length > 0 &&
        !allowedUsers.includes(event.user)
      ) {
        return;
      }
      const channelId = event.channel;
      if (!channelId) return;
      if (
        allowedChannels &&
        allowedChannels.length > 0 &&
        !allowedChannels.includes(channelId)
      ) {
        return;
      }

      // Dedupe on envelope id AND event id — drop if either was seen.
      // Runs AFTER relevance filtering so high-volume irrelevant channel
      // traffic can't evict a recent DM/mention's ids from the LRU within
      // Slack's retry window (dupes of dropped events don't matter).
      const eventId = p.event_id ?? event.event_id;
      if (envelopeId && this.markSeen(`env:${envelopeId}`)) return;
      if (eventId && this.markSeen(`evt:${eventId}`)) return;

      // Strip a leading <@BOTID> mention from app_mention text.
      let text = event.text ?? "";
      if (isMention) text = text.replace(/^\s*<@[^>]+>\s*/, "");

      const threadKey =
        event.thread_ts ??
        (event.channel_type === "im" ? channelId : (event.ts ?? channelId));

      const msg: InboundMessage = {
        channelType: "slack",
        teamId: p.team_id ?? this.teamId ?? undefined,
        channelId,
        threadKey,
        userId: event.user,
        text,
        raw: event,
      };

      const sink = this.sink;
      if (!sink) return;
      // Fire-and-forget — must not block the socket handler.
      void this.opts.coordinator.handle(msg, sink).catch((err) => {
        this.logErr("coordinator.handle failed", err);
      });
    } catch (err) {
      this.logErr("handleEvent failed", err);
    }
  };

  private buildSink(client: SlackClientLike): OutboundSink {
    return {
      postPlaceholder: async (msg: InboundMessage): Promise<string> => {
        const threadTs = this.threadTsFor(msg);
        const { ts } = await client.postMessage(
          msg.channelId,
          ":hourglass_flowing_sand: working…",
          threadTs,
        );
        return ts;
      },

      finalize: async (
        msg: InboundMessage,
        placeholderId: string,
        markdown: string,
        meta: { cost: number; toolCalls: string[] },
      ): Promise<void> => {
        let text = markdownToMrkdwn(truncateForSlack(markdown));
        if (meta.toolCalls.length > 0) {
          const n = meta.toolCalls.length;
          const plural = n === 1 ? "" : "s";
          text += `\n\n_${n} tool call${plural} · $${meta.cost.toFixed(4)}_`;
        }
        await client.update(msg.channelId, placeholderId, text);
      },

      postError: async (
        msg: InboundMessage,
        placeholderId: string | null,
        error: string,
      ): Promise<void> => {
        const line = `:warning: ${this.sanitizeError(error)}`;
        if (placeholderId) {
          await client.update(msg.channelId, placeholderId, line);
        } else {
          await client.postMessage(msg.channelId, line, this.threadTsFor(msg));
        }
      },
    };
  }

  /**
   * Thread ts to reply into. For an IM's top-level message the threadKey
   * equals the channel id — post WITHOUT a thread_ts. Otherwise the
   * threadKey is a real thread anchor (thread_ts or the mention's ts).
   */
  private threadTsFor(msg: InboundMessage): string | undefined {
    return msg.threadKey !== msg.channelId ? msg.threadKey : undefined;
  }

  /** First line of the error, no stack traces or internals, length-capped. */
  private sanitizeError(error: string): string {
    const firstLine = (error ?? "").split("\n")[0].trim();
    const clean = firstLine.length > 0 ? firstLine : "Something went wrong.";
    return clean.length > 300 ? clean.slice(0, 297) + "…" : clean;
  }

  /**
   * Record `key`; return true if it was already present. Insertion-ordered
   * eviction keeps the cache at DEDUPE_CACHE_CAP.
   */
  private markSeen(key: string): boolean {
    if (this.seen.has(key)) return true;
    while (this.seen.size >= DEDUPE_CACHE_CAP) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.seen.set(key, Date.now());
    return false;
  }

  private logErr(msg: string, err: unknown): void {
    if (this.opts.onLog) this.opts.onLog(msg, err);
    else log.error({ err }, msg);
  }
}
