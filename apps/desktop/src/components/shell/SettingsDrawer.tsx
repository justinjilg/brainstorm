/**
 * SettingsDrawer — the engine room as a drawer, not a place.
 *
 * Absorbs the former Platform·Configure sub-tabs (Models, Config/keys/budget,
 * Security) into one modal so the four places stay about the living system, not
 * administration. Opened with the rail gear or ⌘, — closed with Esc. This keeps
 * all the power while stripping its claim on the app's identity.
 */
import { useEffect, useState } from "react";
import { ModelsView } from "../models/ModelsView";
import { ConfigView } from "../config/ConfigView";
import { SecurityView } from "../security/SecurityView";

type Tab = "models" | "config" | "security";

const TABS: { id: Tab; label: string }[] = [
  { id: "models", label: "Models & keys" },
  { id: "config", label: "Config & budget" },
  { id: "security", label: "Security & autonomy" },
];

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  initialTab?: Tab;
  onModelSelect?: (id: string, name: string, provider: string) => void;
}

export function SettingsDrawer({
  open,
  onClose,
  initialTab = "models",
  onModelSelect,
}: SettingsDrawerProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 50 }}
      className="flex items-stretch justify-end"
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
        }}
      />
      <div
        data-testid="settings-drawer"
        className="animate-slide-in-right relative flex flex-col"
        style={{
          width: "min(720px, 96vw)",
          background: "var(--ctp-mantle)",
          borderLeft: "1px solid var(--border-subtle)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <header
          className="shrink-0 flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        >
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="px-2.5 py-1 rounded"
                style={{
                  fontSize: "var(--text-xs)",
                  background:
                    tab === t.id ? "var(--ctp-surface0)" : "transparent",
                  color:
                    tab === t.id ? "var(--ctp-text)" : "var(--ctp-overlay1)",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-overlay1)" }}
            className="opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "models" && <ModelsView onModelSelect={onModelSelect} />}
          {tab === "config" && <ConfigView />}
          {tab === "security" && <SecurityView />}
        </div>
      </div>
    </div>
  );
}
