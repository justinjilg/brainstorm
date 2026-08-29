/**
 * Command Palette — Cmd+K fuzzy search across actions, modes, models, skills.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { PlaceId } from "../places/registry";
import { fuzzyFilter } from "../lib/fuzzy";
import { useModels, useSkills } from "../hooks/useServerData";

export type SettingsTab = "models" | "config" | "security";

interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Navigate to a canvas place (typed — no legacy mode strings). */
  onNavigate: (place: PlaceId) => void;
  /** Open the Settings drawer on a given tab. */
  onOpenSettings: (tab: SettingsTab) => void;
  /** Open the Pulse feed. */
  onOpenPulse: () => void;
  onModelSwitch?: (name: string, provider: string, id?: string) => void;
  onRoleSwitch?: (roleId: string | null) => void;
  onNewConversation?: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onOpenSettings,
  onOpenPulse,
  onModelSwitch,
  onRoleSwitch,
  onNewConversation,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Pull live data so palette commands track the real registry. Pre-fix the
  // palette had four hardcoded "Switch to Claude Opus 4.6" / etc. entries
  // that silently drifted from the actual loaded models, and no way to
  // activate a skill by name.
  const { models: allModels } = useModels();
  const { skills: allSkills } = useSkills();

  const dynamicCommands: PaletteCommand[] = useMemo(() => {
    const cmds: PaletteCommand[] = [];
    for (const m of allModels) {
      if (m.status !== "available") continue;
      cmds.push({
        id: `model-dyn-${m.id}`,
        label: `Switch to ${m.name}`,
        category: "Model",
        action: () => onModelSwitch?.(m.name, m.provider, m.id),
      });
    }
    for (const s of allSkills) {
      cmds.push({
        id: `skill-dyn-${s.name}`,
        label: `Show skill: ${s.name}`,
        category: "Skill",
        // Skills live in the Growth place.
        action: () => onNavigate("growth"),
      });
    }
    return cmds;
  }, [allModels, allSkills, onModelSwitch, onNavigate]);

  const commands: PaletteCommand[] = [
    // Navigate — the four places + Pulse (typed, matches the real shell)
    {
      id: "nav-talk",
      label: "Go to Talk",
      category: "Navigate",
      shortcut: "⌘1",
      action: () => onNavigate("talk"),
    },
    {
      id: "nav-council",
      label: "Go to Council",
      category: "Navigate",
      shortcut: "⌘2",
      action: () => onNavigate("council"),
    },
    {
      id: "nav-growth",
      label: "Go to Growth (memory & skills)",
      category: "Navigate",
      shortcut: "⌘3",
      action: () => onNavigate("growth"),
    },
    {
      id: "nav-pulse",
      label: "Open Pulse (the organism)",
      category: "Navigate",
      shortcut: "⌘0",
      action: () => onOpenPulse(),
    },
    {
      id: "nav-settings-models",
      label: "Settings: Models & keys",
      category: "Navigate",
      action: () => onOpenSettings("models"),
    },
    {
      id: "nav-settings-config",
      label: "Settings: Config & budget",
      category: "Navigate",
      action: () => onOpenSettings("config"),
    },
    {
      id: "nav-settings-security",
      label: "Settings: Security & autonomy",
      category: "Navigate",
      action: () => onOpenSettings("security"),
    },

    // Actions
    {
      id: "new-conversation",
      label: "New Conversation",
      category: "Chat",
      shortcut: "⌘N",
      action: () => onNewConversation?.(),
    },

    // Models
    // Model IDs pass through to App.setActiveModelId so the palette actually
    // changes the routed model, not just the StatusRail display name. These
    // ids match the canonical model-registry keys; if a model isn't present
    // in the loaded registry the router will fall back to its default.
    {
      id: "model-opus",
      label: "Switch to Claude Opus 5",
      category: "Model",
      action: () =>
        onModelSwitch?.("Claude Opus 5", "anthropic", "claude-opus-5"),
    },
    {
      id: "model-sonnet",
      label: "Switch to Claude Sonnet 5",
      category: "Model",
      action: () =>
        onModelSwitch?.("Claude Sonnet 5", "anthropic", "claude-sonnet-5"),
    },
    {
      id: "model-gpt",
      label: "Switch to GPT-5.4",
      category: "Model",
      action: () => onModelSwitch?.("GPT-5.4", "openai", "gpt-5.4"),
    },
    {
      id: "model-gemini",
      label: "Switch to Gemini 3.1 Pro",
      category: "Model",
      action: () =>
        onModelSwitch?.("Gemini 3.1 Pro", "google", "gemini-3.1-pro"),
    },

    // Roles
    {
      id: "role-architect",
      label: "Activate Architect Role",
      category: "Role",
      action: () => onRoleSwitch?.("architect"),
    },
    {
      id: "role-developer",
      label: "Activate Developer Role",
      category: "Role",
      action: () => onRoleSwitch?.("developer"),
    },
    {
      id: "role-qa",
      label: "Activate QA Role",
      category: "Role",
      action: () => onRoleSwitch?.("qa"),
    },
    {
      id: "role-clear",
      label: "Clear Role",
      category: "Role",
      action: () => onRoleSwitch?.(null),
    },

    // KAIROS
    {
      id: "kairos-config",
      label: "KAIROS autonomy settings",
      category: "KAIROS",
      shortcut: "⌘/",
      action: () => onOpenSettings("security"),
    },
    {
      id: "kairos-log",
      label: "View KAIROS activity (Pulse)",
      category: "KAIROS",
      shortcut: "⌘L",
      action: () => onOpenPulse(),
    },

    // Security
    {
      id: "red-team",
      label: "Security & autonomy settings",
      category: "Security",
      action: () => onOpenSettings("security"),
    },
    {
      id: "dream",
      label: "View Memory (Growth)",
      category: "Memory",
      action: () => onNavigate("growth"),
    },
  ];

  // Static commands (modes, toggles, hardcoded curated model shortcuts)
  // come first so users with the old mental model still land on the same
  // entries; dynamic commands (every loaded model + every loaded skill)
  // extend the surface. Empty query shows only the static list — the
  // dynamic list would be overwhelming without a filter.
  const allCommands = useMemo(
    () => [...commands, ...dynamicCommands],
    [commands, dynamicCommands],
  );

  // Fuzzy scoring so "gocfg" → "Go to Config" and "vmem" → "View Memory"
  // work. Pre-fix this was a substring match on label + category, which
  // matched "Go to Config" from "go to config" and little else.
  const filtered = query
    ? fuzzyFilter(
        allCommands,
        query,
        (c) => c.label,
        (c) => c.category,
      ).map((m) => m.item)
    : commands;

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const executeCommand = useCallback(
    (cmd: PaletteCommand) => {
      cmd.action();
      onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && filtered[selectedIndex]) {
        executeCommand(filtered[selectedIndex]);
      }
    },
    [onClose, filtered, selectedIndex, executeCommand],
  );

  if (!open) return null;

  // Group by category
  const groups = new Map<string, PaletteCommand[]>();
  for (const cmd of filtered) {
    const list = groups.get(cmd.category) ?? [];
    list.push(cmd);
    groups.set(cmd.category, list);
  }

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-float" />

      {/* Palette */}
      <div
        data-testid="command-palette"
        className="relative w-[520px] max-h-[420px] rounded-2xl overflow-hidden flex flex-col animate-fade-in"
        style={{
          background: "var(--surface-float)",
          boxShadow: "var(--shadow-float)",
          border: "1px solid var(--border-default)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div
          className="px-5 py-4"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            data-testid="palette-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            style={{ fontSize: "var(--text-base)" }}
            className="w-full bg-transparent text-[var(--ctp-text)] outline-none placeholder:text-[var(--ctp-overlay0)]"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto py-1">
          {[...groups.entries()].map(([category, cmds]) => (
            <div key={category}>
              <div
                className="px-5 py-1.5"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase" as const,
                }}
              >
                {category}
              </div>
              {cmds.map((cmd) => {
                const idx = flatIndex++;
                return (
                  <button
                    key={cmd.id}
                    data-testid={`cmd-${cmd.id}`}
                    onClick={() => executeCommand(cmd)}
                    className={`w-full flex items-center justify-between px-4 py-1.5 text-sm transition-colors ${
                      idx === selectedIndex
                        ? "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
                        : "text-[var(--ctp-subtext1)] hover:bg-[var(--ctp-surface0)]/50"
                    }`}
                  >
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <span className="text-[10px] text-[var(--ctp-overlay0)] font-mono">
                        {cmd.shortcut}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-[var(--ctp-overlay0)]">
              No commands match "{query}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
