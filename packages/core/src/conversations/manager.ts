/**
 * ConversationManager — multi-conversation support with shared memory.
 *
 * A conversation groups multiple sessions under a single thread with:
 * - Shared metadata (name, description, tags)
 * - Per-conversation memory overrides (inject or suppress memory entries)
 * - Model override (pin a conversation to a specific model)
 * - Session history (fork, list, resume within a conversation)
 *
 * Memory is project-scoped and shared across all conversations.
 * Memory overrides let individual conversations customize what the agent "knows"
 * without mutating the shared memory store.
 */

import type Database from "better-sqlite3";
import { createLogger } from "@brainst0rm/shared";
import {
  ConversationRepository,
  SessionRepository,
  type Conversation,
} from "@brainst0rm/db";
import type { MemoryManager, MemoryEntry } from "../memory/manager.js";

const log = createLogger("conversations");

export interface ConversationContext {
  conversation: Conversation;
  /** Memory entries with overrides applied. */
  effectiveMemory: MemoryEntry[];
  /** Model to use (conversation override or default). */
  effectiveModel: string | null;
}

export interface CreateConversationOpts {
  name?: string;
  description?: string;
  tags?: string[];
  modelOverride?: string;
  memoryOverrides?: Record<string, string | null>;
  metadata?: Record<string, unknown>;
}

export class ConversationManager {
  private conversations: ConversationRepository;
  private sessions: SessionRepository;

  constructor(
    private db: Database.Database,
    private memoryManager: MemoryManager,
  ) {
    this.conversations = new ConversationRepository(db);
    this.sessions = new SessionRepository(db);
  }

  /** Create a new conversation in a project. */
  create(projectPath: string, opts?: CreateConversationOpts): Conversation {
    const conv = this.conversations.create(projectPath, opts);
    log.info(
      { id: conv.id, name: conv.name, project: projectPath },
      "Conversation created",
    );
    return conv;
  }

  /** Get a conversation by ID. */
  get(id: string): Conversation | null {
    return this.conversations.get(id);
  }

  /** List conversations for a project. */
  list(
    projectPath?: string,
    opts?: { includeArchived?: boolean; limit?: number },
  ): Conversation[] {
    return this.conversations.list(projectPath, opts);
  }

  /** Update conversation metadata. */
  update(
    id: string,
    updates: Partial<
      Pick<
        Conversation,
        | "name"
        | "description"
        | "tags"
        | "modelOverride"
        | "memoryOverrides"
        | "metadata"
        | "isArchived"
      >
    >,
  ): Conversation | null {
    const result = this.conversations.update(id, updates);
    if (result) {
      log.info({ id, updates: Object.keys(updates) }, "Conversation updated");
    }
    return result;
  }

  /** Delete a conversation and unlink its sessions. */
  delete(id: string): boolean {
    return this.conversations.delete(id);
  }

  /** Archive a conversation (soft delete). */
  archive(id: string): Conversation | null {
    return this.conversations.update(id, { isArchived: true });
  }

  /** Fork a conversation — copies metadata, not sessions. */
  fork(id: string, newName?: string): Conversation | null {
    const forked = this.conversations.fork(id, newName);
    if (forked) {
      log.info({ originalId: id, forkedId: forked.id }, "Conversation forked");
    }
    return forked;
  }

  /**
   * Start a new session within a conversation.
   * Links the session to the conversation automatically.
   */
  startSession(conversationId: string): {
    session: import("@brainst0rm/shared").Session;
    conversation: Conversation;
  } | null {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;

    const session = this.sessions.create(conv.projectPath);
    this.conversations.linkSession(session.id, conversationId);
    this.conversations.touchLastMessage(conversationId);

    return { session, conversation: conv };
  }

  /** Get all sessions in a conversation. */
  getSessions(conversationId: string) {
    return this.conversations.getSessions(conversationId);
  }

  /**
   * Build the effective context for a conversation.
   *
   * Applies memory overrides:
   * - If override value is a string, it replaces the memory content
   * - If override value is null, the memory entry is suppressed
   * - Unmentioned entries pass through unchanged
   */
  getContext(conversationId: string): ConversationContext | null {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;

    const allMemory = this.memoryManager.list();
    const overrides = conv.memoryOverrides;

    const effectiveMemory = allMemory
      .filter((m) => {
        // If override is null, suppress this entry
        if (m.id in overrides && overrides[m.id] === null) return false;
        return true;
      })
      .map((m) => {
        // If override has a string value, replace content
        if (m.id in overrides && typeof overrides[m.id] === "string") {
          return { ...m, content: overrides[m.id] as string };
        }
        return m;
      });

    return {
      conversation: conv,
      effectiveMemory,
      effectiveModel: conv.modelOverride,
    };
  }

  /**
   * Build a context string for system prompt injection.
   * Like MemoryManager.getContextString() but with conversation overrides applied.
   */
  getContextString(conversationId: string): string {
    const ctx = this.getContext(conversationId);
    if (!ctx) return this.memoryManager.getContextString();

    const parts: string[] = [];
    const systemEntries = ctx.effectiveMemory.filter(
      (m) => m.tier === "system",
    );
    const archiveEntries = ctx.effectiveMemory.filter(
      (m) => m.tier === "archive",
    );

    if (systemEntries.length > 0) {
      parts.push("### Active Memory (always loaded)\n");
      for (const m of systemEntries) {
        parts.push(`**${m.name}** (${m.type}): ${m.description}`);
        parts.push(m.content);
        parts.push("");
      }
    }

    if (archiveEntries.length > 0) {
      parts.push("### Archive (search to load)\n");
      for (const m of archiveEntries) {
        parts.push(`- **${m.name}** — ${m.description}`);
      }
      parts.push("");
    }

    if (Object.keys(ctx.conversation.memoryOverrides).length > 0) {
      const suppressed = Object.entries(ctx.conversation.memoryOverrides)
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      const overridden = Object.entries(ctx.conversation.memoryOverrides)
        .filter(([, v]) => typeof v === "string")
        .map(([k]) => k);

      if (suppressed.length > 0 || overridden.length > 0) {
        parts.push("### Conversation Overrides\n");
        if (suppressed.length > 0)
          parts.push(`Suppressed: ${suppressed.join(", ")}`);
        if (overridden.length > 0)
          parts.push(`Overridden: ${overridden.join(", ")}`);
        parts.push("");
      }
    }

    return parts.join("\n").trim();
  }

  /**
   * Handoff: switch a conversation to a different model.
   * Returns the updated conversation.
   */
  handoff(conversationId: string, newModelId: string): Conversation | null {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;

    log.info(
      {
        id: conversationId,
        from: conv.modelOverride ?? "default",
        to: newModelId,
      },
      "Conversation model handoff",
    );

    return this.conversations.update(conversationId, {
      modelOverride: newModelId,
      metadata: {
        ...conv.metadata,
        handoffHistory: [
          ...((conv.metadata.handoffHistory as string[]) ?? []),
          `${conv.modelOverride ?? "default"} → ${newModelId} at ${new Date().toISOString()}`,
        ],
      },
    });
  }

  /** Get total cost across all sessions in a conversation. */
  getTotalCost(conversationId: string): number {
    const sessions = this.conversations.getSessions(conversationId);
    return sessions.reduce((sum, s) => sum + s.totalCost, 0);
  }

  /** Get total message count across all sessions. */
  getTotalMessages(conversationId: string): number {
    const sessions = this.conversations.getSessions(conversationId);
    return sessions.reduce((sum, s) => sum + s.messageCount, 0);
  }
}
