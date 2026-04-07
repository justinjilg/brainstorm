/**
 * Memory View — white-box memory inspector with trust scores.
 * Letta-inspired: see and edit agent memory, trust scoring, quarantine.
 */

import { useState } from "react";

type MemoryTier = "system" | "archive" | "quarantine";

interface MemoryEntry {
  id: string;
  name: string;
  description: string;
  tier: MemoryTier;
  source: string;
  trustScore: number;
  author: string;
  content: string;
  contentHash: string;
  createdAt: string;
}

const DEMO_ENTRIES: MemoryEntry[] = [
  {
    id: "1",
    name: "user-preferences",
    description: "User coding preferences",
    tier: "system",
    source: "user_input",
    trustScore: 1.0,
    author: "human",
    content: "Prefers Opus for code, concise responses, ESM imports",
    contentHash: "a3f2...",
    createdAt: "2026-04-07",
  },
  {
    id: "2",
    name: "project-conventions",
    description: "Project patterns and conventions",
    tier: "system",
    source: "agent_extraction",
    trustScore: 0.5,
    author: "memory-middleware",
    content: "ESM imports, tsup bundling, vitest for tests, pino logger",
    contentHash: "b7c1...",
    createdAt: "2026-04-07",
  },
  {
    id: "3",
    name: "brainstorm-architecture",
    description: "20-package turborepo monorepo",
    tier: "archive",
    source: "agent_extraction",
    trustScore: 0.5,
    author: "memory-middleware",
    content:
      "Turborepo with packages/shared, /config, /db, /providers, /router, /tools, /core, /agents, /workflow, /hooks, /mcp, /eval, /gateway, /vault, /cli, /plugin-sdk, /projects, /scheduler, /orchestrator, /vscode",
    contentHash: "c9d3...",
    createdAt: "2026-04-06",
  },
  {
    id: "4",
    name: "web-extracted-config",
    description: "Config from external website",
    tier: "quarantine",
    source: "web_fetch",
    trustScore: 0.2,
    author: "web_fetch",
    content: "Untrusted configuration pattern extracted from external docs",
    contentHash: "d4e5...",
    createdAt: "2026-04-07",
  },
];

const TIER_CONFIG: Record<
  MemoryTier,
  { label: string; color: string; icon: string }
> = {
  system: {
    label: "System (always in prompt)",
    color: "var(--ctp-green)",
    icon: "●",
  },
  archive: {
    label: "Archive (searchable, on-demand)",
    color: "var(--ctp-blue)",
    icon: "◐",
  },
  quarantine: {
    label: "Quarantine (untrusted)",
    color: "var(--ctp-red)",
    icon: "⚠",
  },
};

export function MemoryView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<MemoryTier | "all">("all");

  const filtered =
    activeTier === "all"
      ? DEMO_ENTRIES
      : DEMO_ENTRIES.filter((e) => e.tier === activeTier);

  const selected = DEMO_ENTRIES.find((e) => e.id === selectedId);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Entry list */}
      <div className="w-[55%] border-r border-[var(--ctp-surface0)] flex flex-col overflow-hidden">
        {/* Tier filter */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--ctp-surface0)]">
          {(["all", "system", "archive", "quarantine"] as const).map((tier) => (
            <button
              key={tier}
              onClick={() => setActiveTier(tier)}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                activeTier === tier
                  ? "bg-[var(--ctp-surface1)] text-[var(--ctp-text)]"
                  : "text-[var(--ctp-overlay0)] hover:text-[var(--ctp-subtext0)]"
              }`}
            >
              {tier === "all"
                ? "All"
                : tier.charAt(0).toUpperCase() + tier.slice(1)}
              {tier !== "all" && (
                <span className="ml-1 text-[var(--ctp-overlay0)]">
                  ({DEMO_ENTRIES.filter((e) => e.tier === tier).length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Entries */}
        <div className="flex-1 overflow-y-auto">
          {filtered.map((entry) => {
            const tierCfg = TIER_CONFIG[entry.tier];
            return (
              <div
                key={entry.id}
                onClick={() => setSelectedId(entry.id)}
                className={`px-4 py-3 cursor-pointer border-b border-[var(--ctp-surface0)]/50 transition-colors ${
                  selectedId === entry.id
                    ? "bg-[var(--ctp-surface0)]"
                    : "hover:bg-[var(--ctp-surface0)]/50"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span style={{ color: tierCfg.color }}>{tierCfg.icon}</span>
                  <span className="text-sm text-[var(--ctp-text)]">
                    {entry.name}
                  </span>
                  <TrustBadge score={entry.trustScore} />
                </div>
                <div className="text-[10px] text-[var(--ctp-overlay0)] ml-5">
                  {entry.source} · {entry.author} · {entry.createdAt}
                </div>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-4 py-2 border-t border-[var(--ctp-surface0)]">
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
            + New Entry
          </button>
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
            Dream Now
          </button>
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
            Git History
          </button>
        </div>
      </div>

      {/* Detail */}
      <div className="w-[45%] overflow-y-auto p-4">
        {selected ? (
          <MemoryDetail entry={selected} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--ctp-overlay0)]">
            Select a memory entry to inspect
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryDetail({ entry }: { entry: MemoryEntry }) {
  const tierCfg = TIER_CONFIG[entry.tier];
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span style={{ color: tierCfg.color }}>{tierCfg.icon}</span>
          <span className="text-lg font-medium text-[var(--ctp-text)]">
            {entry.name}
          </span>
        </div>
        <div className="text-xs text-[var(--ctp-overlay0)]">
          {entry.description}
        </div>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <MetaField label="Source" value={entry.source} />
        <MetaField label="Author" value={entry.author} />
        <MetaField
          label="Trust"
          value={<TrustBadge score={entry.trustScore} />}
        />
        <MetaField label="Hash" value={entry.contentHash} />
        <MetaField
          label="Tier"
          value={<span style={{ color: tierCfg.color }}>{entry.tier}</span>}
        />
        <MetaField label="Created" value={entry.createdAt} />
      </div>

      {/* Content */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider">
            Content
          </span>
          <button
            onClick={() => setEditing(!editing)}
            className="text-[10px] text-[var(--ctp-mauve)] hover:brightness-125"
          >
            {editing ? "Save" : "✎ Edit"}
          </button>
        </div>
        {editing ? (
          <textarea
            defaultValue={entry.content}
            className="w-full h-32 p-2 rounded-lg bg-[var(--ctp-surface0)] text-sm text-[var(--ctp-text)] outline-none resize-none border border-[var(--ctp-surface2)] focus:border-[var(--ctp-mauve)]"
          />
        ) : (
          <div className="p-3 rounded-lg bg-[var(--ctp-surface0)] text-sm text-[var(--ctp-text)] whitespace-pre-wrap">
            {entry.content}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {entry.tier !== "system" && (
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-green)]/20 text-[var(--ctp-green)]">
            Promote
          </button>
        )}
        {entry.tier !== "quarantine" && (
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-red)]/20 text-[var(--ctp-red)]">
            Quarantine
          </button>
        )}
        <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)]">
          Delete
        </button>
      </div>
    </div>
  );
}

function TrustBadge({ score }: { score: number }) {
  const color =
    score >= 0.7
      ? "var(--ctp-green)"
      : score >= 0.4
        ? "var(--ctp-yellow)"
        : "var(--ctp-red)";

  return (
    <span
      className="text-[10px] px-1 py-0.5 rounded"
      style={{ color, backgroundColor: `${color}20` }}
    >
      {score.toFixed(1)}
    </span>
  );
}

function MetaField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] text-[var(--ctp-overlay0)]">{label}</div>
      <div className="text-[var(--ctp-subtext1)]">{value}</div>
    </div>
  );
}
