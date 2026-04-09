/**
 * useConversations — manages conversation list from BrainstormServer.
 */

import { useState, useEffect, useCallback } from "react";
import { request } from "../lib/ipc-client";
import type { Conversation } from "../lib/api-client";

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const convs = await request<Conversation[]>("conversations.list");
      setConversations(convs);
    } catch {
      // Failed to load conversations
    }
    setLoading(false);
  }, []);

  const create = useCallback(async (name?: string, modelOverride?: string) => {
    try {
      const conv = await request<Conversation>("conversations.create", {
        name,
        modelOverride,
      });
      if (conv) {
        setConversations((prev) => [conv, ...prev]);
      }
      return conv;
    } catch {
      return null;
    }
  }, []);

  const fork = useCallback(async (id: string, name?: string) => {
    try {
      const conv = await request<Conversation>("conversations.fork", {
        id,
        name,
      });
      if (conv) {
        setConversations((prev) => [conv, ...prev]);
      }
      return conv;
    } catch {
      return null;
    }
  }, []);

  const handoff = useCallback(async (id: string, modelId: string) => {
    try {
      await request("conversations.handoff", { id, modelId });
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { conversations, loading, refresh, create, fork, handoff };
}
