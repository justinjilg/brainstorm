/**
 * useServerData — hooks for fetching real data from BrainstormServer.
 * Wires all views to live data instead of demo placeholders.
 */

import { useState, useEffect, useCallback } from "react";
import { getClient, type HealthResponse } from "../lib/api-client";

// ── Tools ──────────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  description: string;
  permission: string;
}

export function useTools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const client = getClient();
    const data = await client.listTools();
    setTools(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Group tools by category
  const grouped = groupTools(tools);

  return { tools, grouped, loading, refresh, count: tools.length };
}

function groupTools(
  tools: ToolInfo[],
): Array<{ category: string; tools: ToolInfo[]; count: number }> {
  const categories: Record<string, ToolInfo[]> = {};

  for (const tool of tools) {
    let cat = "Other";
    if (tool.name.startsWith("gh_")) cat = "GitHub";
    else if (tool.name.startsWith("git_")) cat = "Git";
    else if (
      tool.name.startsWith("file_") ||
      tool.name === "glob" ||
      tool.name === "grep" ||
      tool.name === "list_dir"
    )
      cat = "File";
    else if (
      tool.name === "shell" ||
      tool.name === "process_spawn" ||
      tool.name === "process_kill"
    )
      cat = "Shell";
    else if (tool.name.startsWith("web_")) cat = "Web";
    else if (tool.name === "memory") cat = "Memory";
    else if (tool.name.startsWith("task_")) cat = "Tasks";
    else if (tool.name.startsWith("br_")) cat = "Intelligence";
    else if (tool.name.startsWith("agent_")) cat = "God Mode";

    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(tool);
  }

  return Object.entries(categories)
    .map(([category, tools]) => ({ category, tools, count: tools.length }))
    .sort((a, b) => b.count - a.count);
}

// ── Health / Stats ─────────────────────────────────────────────────

export function useHealthStats(pollMs = 5000) {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const client = getClient();
    const poll = async () => {
      const h = await client.health();
      setHealth(h);
    };
    poll();
    const interval = setInterval(poll, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  return health;
}
