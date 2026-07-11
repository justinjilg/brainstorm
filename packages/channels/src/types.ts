/**
 * packages/channels — shared contract types.
 *
 * Transport/reasoning split: ChannelAdapter implementations do transport
 * only (receive platform events, post placeholders/results). The
 * IntakeCoordinator is the only thing that touches the agent loop.
 */

export type ChannelAuthority = "read-only" | "approvals" | "full";

export interface InboundMessage {
  channelType: string;
  teamId?: string;
  channelId: string;
  threadKey: string;
  userId: string;
  text: string;
  raw?: unknown;
}

export interface OutboundSink {
  /** Post a "working" indicator, return the platform message id. */
  postPlaceholder(msg: InboundMessage): Promise<string>;
  finalize(
    msg: InboundMessage,
    placeholderId: string,
    markdown: string,
    meta: { cost: number; toolCalls: string[] },
  ): Promise<void>;
  postError(
    msg: InboundMessage,
    placeholderId: string | null,
    error: string,
  ): Promise<void>;
}

export interface ChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
