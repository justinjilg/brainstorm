/**
 * IntakeCoordinator — the only thing in packages/channels that touches the
 * agent loop.
 *
 * Adapters (Slack, etc.) do transport only: they turn a platform event into an
 * {@link InboundMessage} and hand it here with an {@link OutboundSink}. The
 * coordinator resolves/creates the channel-bound session, posts a placeholder,
 * drives {@link runAgentLoop} under the channel's authority, and finalizes the
 * result. It never throws out of {@link handle} — transport failures and loop
 * errors are reported through the sink and logged.
 *
 * Per-thread serialization: two messages arriving in the same thread run
 * sequentially (the second awaits the first); different threads run
 * concurrently.
 */

import { createLogger } from "@brainst0rm/shared";
import type { AgentEvent } from "@brainst0rm/shared";
import {
  runAgentLoop,
  buildSystemPrompt,
  SessionManager,
  createDefaultMiddlewarePipeline,
} from "@brainst0rm/core";
import type { ToolRegistry } from "@brainst0rm/tools";
import type Database from "better-sqlite3";

/**
 * The agent-loop's own options type. We derive the router/registry/costTracker
 * field types from it rather than importing @brainst0rm/{router,providers}
 * directly — those are transitive-only deps of this package, and this keeps the
 * types exactly in lockstep with what runAgentLoop actually consumes.
 */
type LoopOptions = Parameters<typeof runAgentLoop>[1];
import type {
  ChannelAuthority,
  InboundMessage,
  OutboundSink,
} from "./types.js";
import type { ChannelSessionStore } from "./session-store.js";
import { buildAuthorityCheck, BlockedCallCollector } from "./authority.js";
import { renderFinal } from "./render.js";

const log = createLogger("channels");

/**
 * Process-global serialization tail for channel-driven agent runs.
 *
 * `runAgentLoop` installs process-global handlers (`clearTasks`,
 * `setTaskEventHandler`, `setToolOutputHandler`, `setBackgroundEventHandler`)
 * and nulls them in its `finally`. Two loops running concurrently would clobber
 * and cross-contaminate each other's task state and events, and one run's
 * cleanup would tear down the other's handlers. Per-thread serialization is not
 * enough — messages from *different* threads (and different coordinator
 * instances) must not overlap either. So all channel runs chain onto this
 * single module-level tail until that loop state is request-scoped.
 */
let globalRunTail: Promise<void> = Promise.resolve();

/**
 * System-prompt suffix appended for non-`full` authority. Tells the model the
 * mutating tools it may reach for are unavailable in this channel and it should
 * describe what it *would* do instead of attempting the change.
 */
const READ_ONLY_SUFFIX = `

## Channel authority: read-only

You are answering from a chat channel that grants read-only access. Tools that
modify files, run mutating shell commands, or change infrastructure are
unavailable here — attempts to call them will be blocked. Do not pretend a
change succeeded. When a task would require a mutating action, explain clearly
what you WOULD do (the exact commands, edits, or steps) and stop there so a
human can carry it out or approve it.`;

/**
 * Generic notice posted into the channel when a run fails. The detailed error
 * (message, category, stack) is kept in the log only — we don't leak internal
 * paths or model internals to channel members.
 */
const CHANNEL_ERROR_NOTICE =
  "Sorry — I hit an error while handling that request. The details have been logged.";

/**
 * Dependencies for the coordinator. Field types mirror ServerDependencies in
 * packages/server/src/server.ts so an embedder can pass the same objects.
 */
export interface CoordinatorDependencies {
  db: Database.Database;
  config: any;
  registry: LoopOptions["registry"];
  router: LoopOptions["router"];
  costTracker: LoopOptions["costTracker"];
  tools: ToolRegistry;
  projectPath: string;
  sessionStore: ChannelSessionStore;
  /**
   * Refactor seam for tests: inject a fake agent loop. Defaults to the real
   * {@link runAgentLoop}.
   */
  runLoop?: typeof runAgentLoop;
  /**
   * Refactor seam for tests: inject the system-prompt builder. Defaults to the
   * real {@link buildSystemPrompt}. Keeping it injectable lets tests run without
   * touching the on-disk project context.
   */
  buildSystemPrompt?: typeof buildSystemPrompt;
  /**
   * Refactor seam for tests: inject the middleware-pipeline factory. Defaults to
   * the real {@link createDefaultMiddlewarePipeline} (which initializes on-disk
   * memory state); tests inject a no-op to stay hermetic.
   */
  createMiddlewarePipeline?: typeof createDefaultMiddlewarePipeline;
}

export interface CoordinatorOptions {
  authority: ChannelAuthority;
  preferredModelId?: string;
}

export class IntakeCoordinator {
  private readonly deps: CoordinatorDependencies;
  private readonly opts: CoordinatorOptions;
  private readonly runLoop: typeof runAgentLoop;
  private readonly buildSystemPrompt: typeof buildSystemPrompt;
  private readonly createMiddlewarePipeline: typeof createDefaultMiddlewarePipeline;

  constructor(deps: CoordinatorDependencies, opts: CoordinatorOptions) {
    this.deps = deps;
    this.opts = opts;
    this.runLoop = deps.runLoop ?? runAgentLoop;
    this.buildSystemPrompt = deps.buildSystemPrompt ?? buildSystemPrompt;
    this.createMiddlewarePipeline =
      deps.createMiddlewarePipeline ?? createDefaultMiddlewarePipeline;
  }

  /**
   * Handle one inbound message. Globally serialized (see {@link globalRunTail})
   * because the agent loop uses process-global handler state. Never rejects —
   * errors are surfaced via {@link OutboundSink.postError} and logged. Callers
   * invoke this in per-thread arrival order, which the global FIFO chain
   * preserves, so same-thread ordering is maintained too.
   */
  async handle(
    msg: InboundMessage,
    sink: OutboundSink,
    signal?: AbortSignal,
  ): Promise<void> {
    // Chain onto the global tail. `.catch` isolates us from a prior run's
    // rejection (run() swallows its own, but be defensive so one failure can't
    // poison the next message).
    const next = globalRunTail
      .catch(() => {})
      .then(() => this.run(msg, sink, signal));
    globalRunTail = next;
    return next;
  }

  private async run(
    msg: InboundMessage,
    sink: OutboundSink,
    signal?: AbortSignal,
  ): Promise<void> {
    let placeholderId: string | null = null;
    try {
      const sessionId = this.resolveSession(msg);

      // Post the "working" indicator BEFORE consuming the loop, so the channel
      // shows activity immediately.
      placeholderId = await sink.postPlaceholder(msg);

      const events = await this.drive(msg, sessionId, signal);

      // runAgentLoop signals failures by *yielding* an {type:"error"} event and
      // returning without a "done" — it does not throw (see
      // packages/core/src/agent/loop.ts). Surface those as an error, not an
      // empty finalize (Slack chat.update rejects empty text with no_text).
      const errorEvent = events.find(
        (e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error",
      );
      if (errorEvent) throw errorEvent.error;

      const { markdown, toolCalls, cost } = renderFinal(events);
      await sink.finalize(msg, placeholderId, markdown, { cost, toolCalls });
    } catch (err) {
      // Keep the detailed error in the log only; post a generic notice to the
      // channel so we don't leak internal paths/model internals to members.
      log.error(
        { err, threadKey: msg.threadKey, channelId: msg.channelId },
        "channel intake failed",
      );
      // Best-effort error notice; swallow its own failure.
      try {
        await sink.postError(msg, placeholderId, CHANNEL_ERROR_NOTICE);
      } catch (postErr) {
        log.error({ err: postErr }, "failed to post channel error notice");
      }
    }
  }

  /** Resolve an existing channel session or create + bind a new one. */
  private resolveSession(msg: InboundMessage): string {
    const key = {
      channelType: msg.channelType,
      teamId: msg.teamId,
      channelId: msg.channelId,
      threadKey: msg.threadKey,
    };
    const existing = this.deps.sessionStore.resolve(key);
    if (existing) return existing;

    const session = new SessionManager(this.deps.db).start(
      this.deps.projectPath,
    );
    this.deps.sessionStore.bind(key, session.id);
    return session.id;
  }

  /** Run the agent loop and collect its full event stream. */
  private async drive(
    msg: InboundMessage,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<AgentEvent[]> {
    const { prompt } = this.buildSystemPrompt(this.deps.projectPath);
    const systemPrompt =
      this.opts.authority === "full" ? prompt : prompt + READ_ONLY_SUFFIX;

    // TODO(approvals-stage): resumed thread sessions currently carry no prior
    // conversation history — only the newest user message is sent, so a
    // follow-up in the same Slack thread runs without context. Load recent
    // session messages (SessionManager.resume / messages.listBySessionRecent)
    // and prepend them here once threaded continuity is in scope.

    // Approvals stage (later) mines the blocked calls; build the collector now
    // so its behavior is exercised, but the MVP still finalizes read-only.
    const collector =
      this.opts.authority === "approvals" ? new BlockedCallCollector() : null;

    const events: AgentEvent[] = [];
    for await (const event of this.runLoop(
      [{ role: "user", content: msg.text }],
      {
        config: this.deps.config,
        registry: this.deps.registry,
        router: this.deps.router,
        costTracker: this.deps.costTracker,
        tools: this.deps.tools,
        sessionId,
        projectPath: this.deps.projectPath,
        systemPrompt,
        permissionCheck: buildAuthorityCheck(this.opts.authority),
        middleware: this.createMiddlewarePipeline(this.deps.projectPath),
        preferredModelId: this.opts.preferredModelId,
        signal,
      },
    )) {
      events.push(event);
      collector?.consume(event);
    }
    return events;
  }
}
