/**
 * Model Switcher — dropdown for quick model selection from the status rail.
 */

import { useState, useEffect, useRef } from "react";

interface Model {
  id: string;
  name: string;
  provider: string;
  quality: string;
  speed: string;
  price: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
  local: "var(--color-local)",
};

const MODELS: Model[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    quality: "best",
    speed: "slow",
    price: "$15/$75",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    quality: "great",
    speed: "fast",
    price: "$3/$15",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    quality: "best",
    speed: "medium",
    price: "$10/$30",
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    provider: "google",
    quality: "great",
    speed: "fast",
    price: "$2.5/$10",
  },
  {
    id: "gemini-3.1-flash",
    name: "Gemini 3.1 Flash",
    provider: "google",
    quality: "good",
    speed: "fastest",
    price: "$0.08/$0.3",
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    provider: "deepseek",
    quality: "great",
    speed: "fast",
    price: "$0.27/$1.1",
  },
];

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

  // Group by provider
  const filtered = MODELS.filter(
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
          placeholder="Search models..."
          autoFocus
          className="w-full bg-transparent text-xs text-[var(--ctp-text)] outline-none placeholder:text-[var(--ctp-overlay0)]"
        />
      </div>

      <div className="max-h-64 overflow-y-auto py-1">
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
