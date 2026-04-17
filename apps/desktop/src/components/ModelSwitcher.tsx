/**
 * Model Switcher — dropdown for quick model selection from the status rail.
 *
 * Sources models from the live backend via useModels(). Pre-fix this was a
 * hardcoded 6-entry list that drifted from the real registry on every
 * brainstormrouter provider addition; the header pitch was "357 models
 * across 7 providers" but this dropdown only ever showed six of them.
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useModels, type ModelInfo } from "../hooks/useServerData";

interface Model {
  id: string;
  name: string;
  provider: string;
  price: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
  local: "var(--color-local)",
};

// Format pricing into the "$in/$out" string the old static list used, so
// the UI's information density is preserved. Backend sometimes omits
// pricing for local models — fall back to a dash.
function formatPrice(m: ModelInfo): string {
  const p = m.pricing;
  if (!p) return "—";
  const fmt = (n: number) =>
    n === 0 ? "0" : n < 1 ? n.toFixed(2).replace(/\.?0+$/, "") : n.toFixed(0);
  return `$${fmt(p.inputPer1MTokens)}/$${fmt(p.outputPer1MTokens)}`;
}

interface ModelSwitcherProps {
  open: boolean;
  onClose: () => void;
  currentModelId: string | null;
  onSelect: (model: Model) => void;
}

export function ModelSwitcher({
  open,
  onClose,
  currentModelId,
  onSelect,
}: ModelSwitcherProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const { models: serverModels, loading } = useModels();

  // Map backend ModelInfo to the local Model shape the selection callback
  // expects. Sort: available first, then by quality tier ascending.
  const models: Model[] = useMemo(() => {
    return serverModels
      .filter((m) => m.status === "available")
      .slice()
      .sort((a, b) => {
        const qa = a.capabilities?.qualityTier ?? 99;
        const qb = b.capabilities?.qualityTier ?? 99;
        return qa - qb;
      })
      .map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        price: formatPrice(m),
      }));
  }, [serverModels]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose]);

  if (!open) return null;

  // Group by provider (filtered)
  const filtered = models.filter(
    (m) =>
      m.name.toLowerCase().includes(filter.toLowerCase()) ||
      m.provider.toLowerCase().includes(filter.toLowerCase()),
  );

  const providers = [...new Set(filtered.map((m) => m.provider))];

  return (
    <div
      ref={panelRef}
      data-testid="model-switcher"
      className="absolute bottom-8 left-[240px] w-80 bg-[var(--ctp-base)] border border-[var(--ctp-surface1)] rounded-xl shadow-2xl overflow-hidden z-50"
    >
      <div className="px-3 py-2 border-b border-[var(--ctp-surface0)]">
        <input
          type="text"
          value={filter}
          data-testid="model-search"
          onChange={(e) => setFilter(e.target.value)}
          placeholder={
            loading ? "Loading models…" : `Search ${models.length} models…`
          }
          autoFocus
          className="w-full bg-transparent text-xs text-[var(--ctp-text)] outline-none placeholder:text-[var(--ctp-overlay0)]"
        />
      </div>

      <div className="max-h-64 overflow-y-auto py-1">
        {!loading && models.length === 0 && (
          <div
            data-testid="model-switcher-empty"
            className="px-3 py-4 text-[10px] text-[var(--ctp-overlay0)]"
          >
            No models available. Check provider keys in the vault.
          </div>
        )}
        {providers.map((provider) => (
          <div key={provider}>
            <div className="px-3 py-1 text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider">
              {provider}
            </div>
            {filtered
              .filter((m) => m.provider === provider)
              .map((model) => (
                <button
                  key={model.id}
                  data-testid={`model-${model.id}`}
                  onClick={() => {
                    onSelect(model);
                    onClose();
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    currentModelId === model.id
                      ? "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
                      : "text-[var(--ctp-subtext1)] hover:bg-[var(--ctp-surface0)]/50"
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor:
                        PROVIDER_COLORS[model.provider] ??
                        "var(--ctp-overlay0)",
                    }}
                  />
                  <span className="flex-1 text-left">{model.name}</span>
                  <span className="text-[10px] text-[var(--ctp-overlay0)]">
                    {model.price}
                  </span>
                </button>
              ))}
          </div>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-[var(--ctp-surface0)] text-[10px] text-[var(--ctp-overlay0)]">
        Prices per 1M tokens (in/out) · ⌘3 for full model explorer
      </div>
    </div>
  );
}
