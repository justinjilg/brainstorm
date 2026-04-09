/**
 * useServerData — hooks for fetching real data from BrainstormServer.
 * Wires all views to live data instead of demo placeholders.
 */

import { useState, useEffect, useCallback } from "react";
import { request } from "../lib/ipc-client";
import type { HealthResponse } from "../lib/api-client";

// ── Tools ──────────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  description: string;
  permission: string;
}

export function useTools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<ToolInfo[]>("tools.list");
      setTools(data);
    } catch {
      setError("Failed to load tools");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Group tools by category
  const grouped = groupTools(tools);

  return { tools, grouped, loading, error, refresh, count: tools.length };
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
    const poll = async () => {
      try {
        const h = await request<HealthResponse>("health");
        setHealth(h);
      } catch {
        setHealth(null);
      }
    };
    poll();
    const interval = setInterval(poll, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  return health;
}

// ── Memory ─────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  name: string;
  description: string;
  type: string;
  tier: string;
  source: string;
  trustScore: number;
  content: string;
  contentHash: string;
  author?: string;
}

export function useMemory() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<MemoryEntry[]>("memory.list");
      setEntries(data);
    } catch {
      setError("Failed to load memory entries");
    }
    setLoading(false);
  }, []);

  const promote = useCallback(
    async (id: string) => {
      await request("memory.update", { id, tier: "system" });
      refresh();
    },
    [refresh],
  );

  const quarantine = useCallback(
    async (id: string) => {
      await request("memory.update", { id, tier: "quarantine" });
      refresh();
    },
    [refresh],
  );

  const demote = useCallback(
    async (id: string) => {
      await request("memory.update", { id, tier: "archive" });
      refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await request("memory.delete", { id });
      refresh();
    },
    [refresh],
  );

  const create = useCallback(
    async (name: string, content: string) => {
      await request("memory.create", { name, content });
      refresh();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    entries,
    loading,
    error,
    refresh,
    promote,
    quarantine,
    demote,
    remove,
    create,
  };
}

// ── Skills ─────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  source: string;
  content: string;
}

export function useSkills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<SkillInfo[]>("skills.list");
      setSkills(data);
    } catch {
      setError("Failed to load skills");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { skills, loading, error, refresh };
}

// ── Models ─────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  status: string;
  pricing: { inputPer1MTokens: number; outputPer1MTokens: number };
}

// ── Config ────────────────────────────────────────────────────────

export interface AppConfig {
  general?: { defaultModel?: string; outputStyle?: string };
  budget?: {
    sessionLimit?: number;
    dailyLimit?: number;
    monthlyLimit?: number;
    hardLimit?: boolean;
  };
  daemon?: {
    tickIntervalMs?: number;
    maxTicksPerSession?: number;
    approvalGateInterval?: number;
  };
  providers?: Array<{ name: string; enabled: boolean }>;
}

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<AppConfig>("config.get");
      setConfig(data);
    } catch {
      // Config not available
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { config, loading, refresh };
}

// ── Models ────────────────────────────────────────────────────────

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<ModelInfo[]>("models.list");
      setModels(data);
    } catch {
      // Models discovery failed — use empty list
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { models, loading, refresh };
}
