/**
 * Memory View — wired to real BrainstormServer memory API.
 */

import { useState } from "react";
import { useMemory, type MemoryEntry } from "../../hooks/useServerData";

type MemoryTier = "system" | "archive" | "quarantine";

const TIER_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  system: { label: "System", color: "var(--ctp-green)", icon: "●" },
  archive: { label: "Archive", color: "var(--ctp-blue)", icon: "◐" },
  quarantine: { label: "Quarantine", color: "var(--ctp-red)", icon: "⚠" },
};

export function MemoryView() {
  const { entries, loading, promote, quarantine, demote, remove, create } =
    useMemory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<MemoryTier | "all">("all");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  const filtered =
    activeTier === "all"
      ? entries
      : entries.filter((e) => e.tier === activeTier);

  const selected = entries.find((e) => e.id === selectedId);

  const handleCreate = async () => {
    if (newName && newContent) {
      await create(newName, newContent);
      setNewName("");
      setNewContent("");
      setShowCreateForm(false);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden bg-[var(--ctp-base)]">
      {/* Entry list */}
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: "55%",
          borderRight: "1px solid var(--border-subtle)",
        }}
      >
        {/* Tier filter */}
        <div
          className="flex items-center gap-1 px-4 py-2"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        >
          {(["all", "system", "archive", "quarantine"] as const).map((tier) => (
            <button
              key={tier}
              onClick={() => setActiveTier(tier)}
              className="interactive px-2 py-1 rounded-md"
              style={{
                fontSize: "var(--text-2xs)",
                color:
                  activeTier === tier
                    ? "var(--ctp-text)"
                    : "var(--ctp-overlay0)",
                background:
                  activeTier === tier ? "var(--ctp-surface0)" : "transparent",
              }}
            >
              {tier === "all"
                ? `All (${entries.length})`
                : `${tier} (${entries.filter((e) => e.tier === tier).length})`}
            </button>
          ))}
        </div>

        {/* Entries */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div
              className="p-4 animate-pulse-glow"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ctp-overlay1)",
              }}
            >
              Loading memory entries...
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="p-4 text-center"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              No entries{activeTier !== "all" ? ` in ${activeTier} tier` : ""}
            </div>
          ) : (
            filtered.map((entry) => {
              const tierCfg = TIER_CONFIG[entry.tier] ?? TIER_CONFIG.archive;
              return (
                <div
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id)}
                  className="interactive px-4 py-3"
                  style={{
                    borderBottom: "1px solid var(--border-subtle)",
                    background:
                      selectedId === entry.id
                        ? "var(--ctp-surface0)"
                        : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span style={{ color: tierCfg.color }}>{tierCfg.icon}</span>
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--ctp-text)",
                      }}
                    >
                      {entry.name}
                    </span>
                    <TrustBadge score={entry.trustScore} />
                  </div>
                  <div
                    className="ml-5"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ctp-overlay0)",
                    }}
                  >
                    {entry.source} · {entry.type}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Actions */}
        <div
          className="flex items-center gap-2 px-4 py-2"
          style={{ borderTop: "1px solid var(--border-subtle)" }}
        >
          <button
            onClick={() => setShowCreateForm(true)}
            className="interactive px-2 py-1 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              border: "1px solid var(--border-default)",
              color: "var(--ctp-overlay1)",
            }}
          >
            + New Entry
          </button>
        </div>

        {/* Create form */}
        {showCreateForm && (
          <div
            className="px-4 py-3 animate-fade-in"
            style={{
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--ctp-surface0)",
            }}
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Entry name"
              className="w-full bg-transparent outline-none mb-2 text-[var(--ctp-text)]"
              style={{ fontSize: "var(--text-xs)" }}
            />
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Content..."
              rows={3}
              className="w-full bg-transparent outline-none resize-none text-[var(--ctp-text)] mb-2"
              style={{ fontSize: "var(--text-xs)" }}
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                className="interactive px-3 py-1 rounded-lg bg-[var(--ctp-mauve)] text-[var(--ctp-crust)]"
                style={{ fontSize: "var(--text-2xs)" }}
              >
                Save
              </button>
              <button
                onClick={() => setShowCreateForm(false)}
                className="interactive px-3 py-1 rounded-lg"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {selected ? (
          <MemoryDetail
            entry={selected}
            onPromote={() => promote(selected.id)}
            onQuarantine={() => quarantine(selected.id)}
            onDemote={() => demote(selected.id)}
            onDelete={() => {
              remove(selected.id);
              setSelectedId(null);
            }}
          />
        ) : (
          <div
            className="flex items-center justify-center h-full"
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Select a memory entry to inspect
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryDetail({
  entry,
  onPromote,
  onQuarantine,
  onDemote,
  onDelete,
}: {
  entry: MemoryEntry;
  onPromote: () => void;
  onQuarantine: () => void;
  onDemote: () => void;
  onDelete: () => void;
}) {
  const tierCfg = TIER_CONFIG[entry.tier] ?? TIER_CONFIG.archive;

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span style={{ color: tierCfg.color }}>{tierCfg.icon}</span>
          <span
            className="font-medium"
            style={{ fontSize: "var(--text-lg)", color: "var(--ctp-text)" }}
          >
            {entry.name}
          </span>
        </div>
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--ctp-overlay0)" }}
        >
          {entry.description}
        </div>
      </div>

      <div
        className="grid grid-cols-2 gap-3"
        style={{ fontSize: "var(--text-xs)" }}
      >
        <MetaField label="Source" value={entry.source} />
        <MetaField label="Type" value={entry.type} />
        <MetaField
          label="Trust"
          value={<TrustBadge score={entry.trustScore} />}
        />
        <MetaField
          label="Tier"
          value={<span style={{ color: tierCfg.color }}>{entry.tier}</span>}
        />
      </div>

      <div
        className="p-4 rounded-xl"
        style={{
          background: "var(--ctp-surface0)",
          border: "1px solid var(--border-subtle)",
          fontSize: "var(--text-sm)",
          color: "var(--ctp-text)",
          lineHeight: "1.6",
          whiteSpace: "pre-wrap",
        }}
      >
        {entry.content}
      </div>

      <div className="flex gap-2">
        {entry.tier !== "system" && (
          <button
            onClick={onPromote}
            className="interactive px-3 py-1.5 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              background: "var(--glow-green)",
              color: "var(--ctp-green)",
              border: "1px solid rgba(166, 227, 161, 0.2)",
            }}
          >
            Promote to System
          </button>
        )}
        {entry.tier === "system" && (
          <button
            onClick={onDemote}
            className="interactive px-3 py-1.5 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-blue)",
              border: "1px solid var(--border-default)",
            }}
          >
            Demote to Archive
          </button>
        )}
        {entry.tier !== "quarantine" && (
          <button
            onClick={onQuarantine}
            className="interactive px-3 py-1.5 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              background: "var(--glow-red)",
              color: "var(--ctp-red)",
              border: "1px solid rgba(243, 139, 168, 0.2)",
            }}
          >
            Quarantine
          </button>
        )}
        <button
          onClick={onDelete}
          className="interactive px-3 py-1.5 rounded-lg"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            border: "1px solid var(--border-default)",
          }}
        >
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
      className="px-1.5 py-0.5 rounded-md"
      style={{
        fontSize: "var(--text-2xs)",
        color,
        background: `${color}15`,
      }}
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
      <div
        style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
      >
        {label}
      </div>
      <div style={{ color: "var(--ctp-subtext1)" }}>{value}</div>
    </div>
  );
}
