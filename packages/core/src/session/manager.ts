import { SessionRepository, MessageRepository } from '@brainstorm/db';
import type { Session, TurnContext } from '@brainstorm/shared';
import { formatTurnContext } from '@brainstorm/shared';
import { estimateTokenCount, needsCompaction, compactContext } from './compaction.js';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class SessionManager {
  private sessions: SessionRepository;
  private messages: MessageRepository;
  private currentSession: Session | null = null;
  private conversationHistory: ConversationMessage[] = [];
  private turnCount = 0;
  private sessionStartTime = Date.now();

  constructor(private db: any) {
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
  }

  start(projectPath: string): Session {
    this.currentSession = this.sessions.create(projectPath);
    this.conversationHistory = [];
    return this.currentSession;
  }

  resume(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    this.currentSession = session;
    const msgs = this.messages.listBySession(sessionId);
    this.conversationHistory = msgs
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

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
      this.messages.create(forked.id, m.role, m.content, m.modelId, m.tokenCount);
    }

    // Set as current session
    this.currentSession = forked;
    this.conversationHistory = msgs
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

    return forked;
  }

  addUserMessage(content: string): void {
    if (!this.currentSession) throw new Error('No active session');
    this.messages.create(this.currentSession.id, 'user', content);
    this.sessions.incrementMessages(this.currentSession.id);
    this.conversationHistory.push({ role: 'user', content });
  }

  addAssistantMessage(content: string, modelId?: string): void {
    if (!this.currentSession) throw new Error('No active session');
    this.messages.create(this.currentSession.id, 'assistant', content, modelId);
    this.sessions.incrementMessages(this.currentSession.id);
    this.conversationHistory.push({ role: 'assistant', content });
  }

  /** Inject turn context as an invisible system message the model sees but the user doesn't. */
  addTurnContext(ctx: TurnContext): void {
    const summary = formatTurnContext(ctx);
    this.conversationHistory.push({ role: 'system', content: summary });
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
    return estimateTokenCount(this.conversationHistory);
  }

  needsCompaction(contextWindow: number): boolean {
    return needsCompaction(this.conversationHistory, contextWindow);
  }

  async compact(options: {
    contextWindow: number;
    keepRecent?: number;
    summarizeModel?: any;
  }): Promise<{ compacted: boolean; removed: number; tokensBefore: number; tokensAfter: number; summaryCost: number }> {
    const tokensBefore = estimateTokenCount(this.conversationHistory);
    const result = await compactContext(this.conversationHistory, options);

    if (result.compacted) {
      const removed = this.conversationHistory.length - result.messages.length;
      this.conversationHistory = result.messages;
      const tokensAfter = estimateTokenCount(this.conversationHistory);
      return { compacted: true, removed, tokensBefore, tokensAfter, summaryCost: result.summaryCost };
    }

    return { compacted: false, removed: 0, tokensBefore, tokensAfter: tokensBefore, summaryCost: 0 };
  }
}
