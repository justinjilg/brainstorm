/**
 * useConversations — manages conversation list from BrainstormServer.
 */

import { useState, useEffect, useCallback } from "react";
import { request } from "../lib/ipc-client";
import type { Conversation } from "../lib/api-client";

export interface UseConversationsOptions {
  /**
   * The active project folder. Conversations created while a project is
   * selected are filed against it, and list operations scope to it so the
   * sidebar only shows conversations belonging to the current project.
   * Changing this value causes an automatic refresh.
   */
  projectPath?: string | null;
}

export function useConversations(options: UseConversationsOptions = {}) {
  const { projectPath } = options;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const convs = await request<Conversation[]>(
        "conversations.list",
        projectPath ? { project: projectPath } : undefined,
      );
      setConversations(convs);
    } catch {
      // Failed to load conversations
    }
    setLoading(false);
  }, [projectPath]);

  const create = useCallback(
    async (name?: string, modelOverride?: string) => {
      try {
        const conv = await request<Conversation>("conversations.create", {
          name,
          modelOverride,
          // Pre-fix: this param was absent, so the backend filed every
          // new conversation under the CLI's cwd (shell pwd when the app
          // launched), not the active project. conversations.list scoped
          // to currentProject then couldn't find them.
          ...(projectPath ? { projectPath } : {}),
        });
        if (conv) {
          setConversations((prev) => [conv, ...prev]);
        }
        return conv;
      } catch {
        return null;
      }
    },
    [projectPath],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { conversations, loading, refresh, create };
}
