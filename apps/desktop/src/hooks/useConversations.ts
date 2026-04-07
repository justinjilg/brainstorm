/**
 * useConversations — manages conversation list from BrainstormServer.
 */

import { useState, useEffect, useCallback } from "react";
import { getClient, type Conversation } from "../lib/api-client";

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const client = getClient();
    const convs = await client.listConversations();
    setConversations(convs);
    setLoading(false);
  }, []);

  const create = useCallback(async (name?: string, modelOverride?: string) => {
    const client = getClient();
    const conv = await client.createConversation({ name, modelOverride });
    if (conv) {
      setConversations((prev) => [conv, ...prev]);
    }
    return conv;
  }, []);

  const fork = useCallback(async (id: string, name?: string) => {
    const client = getClient();
    const conv = await client.forkConversation(id, name);
    if (conv) {
      setConversations((prev) => [conv, ...prev]);
    }
    return conv;
  }, []);

  const handoff = useCallback(async (id: string, modelId: string) => {
    const client = getClient();
    return client.handoff(id, modelId);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { conversations, loading, refresh, create, fork, handoff };
}
