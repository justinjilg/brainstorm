import {
  SessionRepository,
  MessageRepository,
  CompactionCommitRepository,
} from "@brainst0rm/db";
import type { Session, TurnContext } from "@brainst0rm/shared";
import { createLogger, formatTurnContext } from "@brainst0rm/shared";
import {
  estimateTokenCount,
  needsCompaction,
  compactContext,
} from "./compaction.js";

const log = createLogger("session-manager");

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export class SessionManager {
  private sessions: SessionRepository;
  private messages: MessageRepository;
  private currentSession: Session | null = null;
  private conversationHistory: ConversationMessage[] = [];
  private turnCount = 0;
  private sessionStartTime = Date.now();
  /** Cached token estimate — updated incrementally on addMessage, invalidated on compact. */
  private cachedTokenCount: number | null = null;
  /** Pending async writes (assistant messages, tool results). Flushed at end of turn. */
  private pendingWrites: Array<() => void> = [];
  /** Repository for reversible compaction commits. */
  private compactionRepo: CompactionCommitRepository;

  constructor(private db: any) {
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.compactionRepo = new CompactionCommitRepository(db);
  }

  start(projectPath: string): Session {
    this.currentSession = this.sessions.create(projectPath);
    this.conversationHistory = [];
    this.cachedTokenCount = 0;
    return this.currentSession;
  }

  resume(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    this.currentSession = session;
    // Lazy load: only keep last 50 messages in memory (older available on demand via DB)
    const msgs = this.messages.listBySessionRecent(sessionId, 50);
    this.conversationHistory = msgs
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
    this.cachedTokenCount = null; // Force recount after resume

    return session;
  }

  /** Resume the most recent session for the given project path. */
  resumeLatest(projectPath?: string): Session | null {
    const recent = this.sessions.listRecent(1);
    if (recent.length === 0) return null;
    const target = projectPath
      ? recent.find((s) => s.projectPath === projectPath)
      : recent[0];
    if (!target) return null;
    return this.resume(target.id);
  }

  /** Fork a session: create a new session with a copy of the conversation history. */
  fork(sessionId: string): Session | null {
    const original = this.sessions.get(sessionId);
    if (!original) return null;

    const forked = this.sessions.create(original.projectPath);
    const msgs = this.messages.listBySession(sessionId);

    // Copy all messages to the new session
    for (const m of msgs) {
      this.messages.create(
        forked.id,
        m.role,
        m.content,
        m.modelId,
        m.tokenCount,
      );
    }

    // Set as current session
    this.currentSession = forked;
    this.conversationHistory = msgs
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    return forked;
  }

  /**
   * Add user message — SYNCHRONOUS write to DB.
   * Critical for crash recovery: --resume needs the user message to exist
   * even if the process dies before the assistant responds.
   */
  addUserMessage(content: string): void {
    if (!this.currentSession) throw new Error("No active session");
    this.messages.create(this.currentSession.id, "user", content);
    this.sessions.incrementMessages(this.currentSession.id);
    this.conversationHistory.push({ role: "user", content });
    this.addTokenDelta(content);
  }

  /**
   * Add assistant message — ASYNC write to DB (fire-and-forget).
   * Assistant responses can be regenerated on crash recovery, so we
   * don't block the event loop waiting for the DB write. The in-memory
   * history is updated immediately for conversation continuity.
   */
  addAssistantMessage(content: string, modelId?: string): void {
    if (!this.currentSession) throw new Error("No active session");
    this.conversationHistory.push({ role: "assistant", content });
    this.addTokenDelta(content);

    // DB write is fire-and-forget — queued for batch flush at end of turn
    const sessionId = this.currentSession.id;
    this.pendingWrites.push(() => {
      try {
        this.messages.create(sessionId, "assistant", content, modelId);
        this.sessions.incrementMessages(sessionId);
      } catch (e) {
        log.warn({ err: e }, "Failed to persist assistant message");
      }
    });
  }

  /** Inject turn context as an invisible system message the model sees but the user doesn't. */
  addTurnContext(ctx: TurnContext): void {
    const summary = formatTurnContext(ctx);
    this.conversationHistory.push({ role: "system", content: summary });
    this.addTokenDelta(summary);
  }

  /** Incrementally update cached token count for a new message. */
  private addTokenDelta(content: string): void {
    if (this.cachedTokenCount !== null) {
      this.cachedTokenCount += Math.ceil((content.length + 20) / 4);
    }
  }

  /**
   * Flush all pending async writes to DB.
   * Call at end of each turn or on graceful shutdown.
   * Uses a single implicit SQLite transaction (WAL mode) for batch efficiency.
   */
  flush(): void {
    if (this.pendingWrites.length === 0) return;
    const writes = this.pendingWrites.splice(0);
    for (const write of writes) {
      write();
    }
  }

  /** Sync session cost to DB. Call after each tool to keep DB accurate. */
  syncSessionCost(cost: number): void {
    if (!this.currentSession) return;
    this.sessions.updateCost(this.currentSession.id, cost);
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  incrementTurn(): number {
    return ++this.turnCount;
  }

  getSessionMinutes(): number {
    return Math.round((Date.now() - this.sessionStartTime) / 60_000);
  }

  getHistory(): ConversationMessage[] {
    return this.conversationHistory;
  }

  getSession(): Session | null {
    return this.currentSession;
  }

  listRecent(limit = 10): Session[] {
    return this.sessions.listRecent(limit);
  }

  getTokenEstimate(): number {
    if (this.cachedTokenCount === null) {
      this.cachedTokenCount = estimateTokenCount(this.conversationHistory);
    }
    return this.cachedTokenCount;
  }

  needsCompaction(contextWindow: number): boolean {
    return needsCompaction(this.conversationHistory, contextWindow);
  }

  async compact(options: {
    contextWindow: number;
    keepRecent?: number;
    summarizeModel?: any;
  }): Promise<{
    compacted: boolean;
    removed: number;
    tokensBefore: number;
    tokensAfter: number;
    summaryCost: number;
  }> {
    const tokensBefore = estimateTokenCount(this.conversationHistory);
    const result = await compactContext(this.conversationHistory, {
      ...options,
      sessionId: this.currentSession?.id,
      commitRepo: this.compactionRepo,
    });

    if (result.compacted) {
      const removed = this.conversationHistory.length - result.messages.length;
      this.conversationHistory = result.messages;
      // Invalidate cache — full recount after compaction
      this.cachedTokenCount = null;
      const tokensAfter = this.getTokenEstimate();
      return {
        compacted: true,
        removed,
        tokensBefore,
        tokensAfter,
        summaryCost: result.summaryCost,
      };
    }

    return {
      compacted: false,
      removed: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      summaryCost: 0,
    };
  }

  /**
   * Rehydrate a compaction — replace the summary message with original messages.
   * Enables "zooming back in" on compacted context for detail recovery.
   * Returns the new token estimate, or null if the commit wasn't found.
   */
  rehydrateCompaction(commitId: string): { tokensAfter: number } | null {
    const commit = this.compactionRepo.get(commitId);
    if (!commit || !this.currentSession) return null;

    // Find the summary message with this commit's tag
    const marker = `[compaction:${commitId}]`;
    const summaryIdx = this.conversationHistory.findIndex((m) =>
      m.content.includes(marker),
    );
    if (summaryIdx === -1) return null;

    // Fetch original messages from DB by session
    const dbMessages = this.messages.listBySession(commit.sessionId);
    if (dbMessages.length === 0) return null;

    // Use the original message IDs to find the right slice.
    // Since we stored count-based IDs, reconstruct from the DB messages
    // that were present before compaction (by count).
    const originalCount = commit.originalMessageIds.length;
    const originals: ConversationMessage[] = dbMessages
      .slice(0, originalCount)
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    if (originals.length === 0) return null;

    // Replace the summary message with the originals
    this.conversationHistory.splice(summaryIdx, 1, ...originals);

    // Invalidate token cache
    this.cachedTokenCount = null;
    const tokensAfter = this.getTokenEstimate();

    log.info(
      { commitId, restored: originals.length, tokensAfter },
      "Rehydrated compaction commit",
    );

    return { tokensAfter };
  }

  /** List compaction commits for the current session. */
  listCompactionCommits(): Array<{
    id: string;
    timestamp: number;
    summary: string;
    keptCount: number;
    summarizedCount: number;
  }> {
    if (!this.currentSession) return [];
    return this.compactionRepo
      .listForSession(this.currentSession.id)
      .map((c) => ({
        id: c.id,
        timestamp: c.timestamp,
        summary: c.summary.slice(0, 200),
        keptCount: c.keptCount,
        summarizedCount: c.summarizedCount,
      }));
  }
}
