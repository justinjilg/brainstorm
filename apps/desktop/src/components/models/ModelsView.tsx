/**
 * Models View — model registry with comparison and ensemble builder.
 */

import { useState } from "react";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  status: "available" | "unavailable";
  quality: number;
  speed: number;
  inputPrice: number;
  outputPrice: number;
}

const DEMO_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    status: "available",
    quality: 95,
    speed: 40,
    inputPrice: 15,
    outputPrice: 75,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    status: "available",
    quality: 85,
    speed: 70,
    inputPrice: 3,
    outputPrice: 15,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    status: "available",
    quality: 90,
    speed: 60,
    inputPrice: 10,
    outputPrice: 30,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    provider: "google",
    status: "available",
    quality: 88,
    speed: 75,
    inputPrice: 2.5,
    outputPrice: 10,
  },
  {
    id: "gemini-3.1-flash",
    name: "Gemini 3.1 Flash",
    provider: "google",
    status: "available",
    quality: 70,
    speed: 95,
    inputPrice: 0.075,
    outputPrice: 0.3,
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    provider: "deepseek",
    status: "available",
    quality: 82,
    speed: 80,
    inputPrice: 0.27,
    outputPrice: 1.1,
  },
];

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
};

export function ModelsView({
  onModelSelect,
}: {
  onModelSelect?: (id: string, name: string, provider: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compared, setCompared] = useState<Set<string>>(new Set());

  const selectedModel = DEMO_MODELS.find((m) => m.id === selected);

  const toggleCompare = (id: string) => {
    setCompared((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Model list */}
      <div className="w-[55%] border-r border-[var(--ctp-surface0)] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ctp-surface0)]">
          <span className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
            Model Explorer ({DEMO_MODELS.length})
          </span>
          <button
            onClick={() => setCompareMode(!compareMode)}
            className={`text-[10px] px-2 py-0.5 rounded ${
              compareMode
                ? "bg-[var(--ctp-mauve)] text-[var(--ctp-crust)]"
                : "text-[var(--ctp-overlay0)] hover:text-[var(--ctp-text)]"
            }`}
          >
            {compareMode ? `Compare (${compared.size})` : "Compare"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {DEMO_MODELS.map((model) => (
            <div
              key={model.id}
              onClick={() =>
                compareMode ? toggleCompare(model.id) : setSelected(model.id)
              }
              className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-[var(--ctp-surface0)]/50 transition-colors ${
                selected === model.id
                  ? "bg-[var(--ctp-surface0)]"
                  : "hover:bg-[var(--ctp-surface0)]/50"
              }`}
            >
              {compareMode && (
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                    compared.has(model.id)
                      ? "border-[var(--ctp-mauve)] bg-[var(--ctp-mauve)] text-[var(--ctp-crust)]"
                      : "border-[var(--ctp-surface2)]"
                  }`}
                >
                  {compared.has(model.id) ? "✓" : ""}
                </span>
              )}
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    PROVIDER_COLORS[model.provider] ?? "var(--ctp-overlay0)",
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--ctp-text)] truncate">
                  {model.name}
                </div>
                <div className="text-[10px] text-[var(--ctp-overlay0)]">
                  {model.provider}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] text-[var(--ctp-overlay1)]">
                  ${model.inputPrice} / ${model.outputPrice}
                </div>
                <div className="text-[10px] text-[var(--ctp-overlay0)]">
                  per 1M tokens
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      <div className="w-[45%] overflow-y-auto p-4">
        {selectedModel ? (
          <ModelDetail model={selectedModel} onSelect={onModelSelect} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--ctp-overlay0)]">
            Select a model to view details
          </div>
        )}
      </div>
    </div>
  );
}

function ModelDetail({
  model,
  onSelect,
}: {
  model: ModelInfo;
  onSelect?: (id: string, name: string, provider: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{
              backgroundColor:
                PROVIDER_COLORS[model.provider] ?? "var(--ctp-overlay0)",
            }}
          />
          <span className="text-lg font-medium text-[var(--ctp-text)]">
            {model.name}
          </span>
        </div>
        <div className="text-xs text-[var(--ctp-overlay0)]">{model.id}</div>
      </div>

      <div className="space-y-2">
        <GaugeRow
          label="Quality"
          value={model.quality}
          color="var(--ctp-green)"
        />
        <GaugeRow label="Speed" value={model.speed} color="var(--ctp-blue)" />
      </div>

      <div className="p-3 rounded-lg bg-[var(--ctp-surface0)]">
        <div className="text-[10px] text-[var(--ctp-overlay0)] mb-2 uppercase tracking-wider">
          Pricing (per 1M tokens)
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--ctp-overlay1)]">Input</span>
          <span className="text-[var(--ctp-text)]">${model.inputPrice}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--ctp-overlay1)]">Output</span>
          <span className="text-[var(--ctp-text)]">${model.outputPrice}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            model.status === "available"
              ? "bg-[var(--ctp-green)]"
              : "bg-[var(--ctp-red)]"
          }`}
        />
        <span className="text-xs text-[var(--ctp-overlay1)]">
          {model.status}
        </span>
      </div>

      <button
        onClick={() => onSelect?.(model.id, model.name, model.provider)}
        className="interactive w-full py-2 rounded-lg text-xs font-medium bg-[var(--ctp-mauve)] text-[var(--ctp-crust)] hover:brightness-110"
      >
        Use This Model
      </button>
    </div>
  );
}

function GaugeRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-[var(--ctp-overlay1)] w-14">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-[var(--ctp-surface0)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs text-[var(--ctp-overlay0)] w-8 text-right">
        {value}%
      </span>
    </div>
  );
}
