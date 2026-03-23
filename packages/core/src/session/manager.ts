import { SessionRepository, MessageRepository } from '@brainstorm/db';
import type { Session } from '@brainstorm/shared';

// We store conversation as simple {role, content} objects
// and convert to ModelMessage format when needed by the AI SDK
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class SessionManager {
  private sessions: SessionRepository;
  private messages: MessageRepository;
  private currentSession: Session | null = null;
  private conversationHistory: ConversationMessage[] = [];

  constructor(db: any) {
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

  getHistory(): ConversationMessage[] {
    return this.conversationHistory;
  }

  getSession(): Session | null {
    return this.currentSession;
  }

  listRecent(limit = 10): Session[] {
    return this.sessions.listRecent(limit);
  }
}
