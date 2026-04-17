/**
 * Models View — model registry, comparison, and detail pane, rebuilt on
 * the BR component layer. The left pane is a sortable data-table; the
 * right pane is a DashCard with pricing + quality/speed gauges.
 */

import { useMemo, useState } from "react";
import { useModels } from "../../hooks/useServerData";
import { DashCard, EmptyState, PageHeader, SkeletonRows } from "../br";

interface ModelRow {
  id: string;
  name: string;
  provider: string;
  status: "available" | "unavailable";
  quality: number;
  speed: number;
  inputPrice: number;
  outputPrice: number;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
};

type SortKey =
  | "name"
  | "provider"
  | "quality"
  | "speed"
  | "inputPrice"
  | "outputPrice";
type SortDir = "asc" | "desc";

export function ModelsView({
  onModelSelect,
}: {
  onModelSelect?: (id: string, name: string, provider: string) => void;
}) {
  const { models: serverModels, loading } = useModels();
  const [selected, setSelected] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compared, setCompared] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("quality");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const rows = useMemo<ModelRow[]>(
    () =>
      serverModels.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        status: (m.status === "available" ? "available" : "unavailable") as
          | "available"
          | "unavailable",
        quality: Math.max(10, 100 - (m.capabilities?.qualityTier ?? 3) * 15),
        speed: Math.max(10, 100 - (m.capabilities?.speedTier ?? 3) * 15),
        inputPrice: m.pricing?.inputPer1MTokens ?? 0,
        outputPrice: m.pricing?.outputPer1MTokens ?? 0,
      })),
    [serverModels],
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === bv) return 0;
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const selectedModel = rows.find((m) => m.id === selected);

  const toggleCompare = (id: string) => {
    setCompared((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      return next;
    });
  };

  const flipSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "provider" ? "asc" : "desc");
    }
  };

  return (
    <div
      className="flex-1 flex overflow-hidden mode-crossfade"
      data-testid="models-view"
      style={{ background: "var(--ink-1)" }}
    >
      <div
        className="flex-1 overflow-y-auto"
        style={{
          padding: "var(--space-6) var(--space-8)",
          maxWidth: 900,
          margin: "0 auto",
          width: "55%",
        }}
      >
        <PageHeader
          title="Models"
          description="Every provider model discovered by the registry — quality, speed, and pricing at a glance. Pick one to route future chat turns through it."
          actions={
            <button
              type="button"
              data-testid="compare-toggle"
              onClick={() => setCompareMode(!compareMode)}
              className={
                compareMode ? "br-btn br-btn-primary" : "br-btn br-btn-ghost"
              }
            >
              {compareMode ? `Compare (${compared.size})` : "Compare"}
            </button>
          }
        />

        <DashCard
          eyebrow="REGISTRY"
          title={`Available models (${rows.length})`}
        >
          {loading ? (
            <SkeletonRows count={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<EmptyModelsMark />}
              heading="No models discovered"
              description="Configure at least one provider (Anthropic, OpenAI, Google, Ollama, …) and the registry will populate."
            />
          ) : (
            <table className="data-table" data-testid="models-table">
              <thead>
                <tr>
                  {compareMode ? (
                    <th style={{ width: 36 }} aria-label="Selector" />
                  ) : null}
                  <Th
                    label="Model"
                    colKey="name"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={flipSort}
                  />
                  <Th
                    label="Provider"
                    colKey="provider"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={flipSort}
                  />
                  <Th
                    label="Quality"
                    colKey="quality"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={flipSort}
                    align="right"
                  />
                  <Th
                    label="Speed"
                    colKey="speed"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={flipSort}
                    align="right"
                  />
                  <Th
                    label="In/Out"
                    colKey="inputPrice"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={flipSort}
                    align="right"
                  />
                </tr>
              </thead>
              <tbody>
                {sorted.map((model) => {
                  const isSelected = selected === model.id;
                  const isCompared = compared.has(model.id);
                  return (
                    <tr
                      key={model.id}
                      data-testid={`model-row-${model.id}`}
                      className={isSelected ? "is-selected" : undefined}
                      onClick={() =>
                        compareMode
                          ? toggleCompare(model.id)
                          : setSelected(model.id)
                      }
                      style={{ cursor: "pointer" }}
                    >
                      {compareMode ? (
                        <td
                          style={{ width: 36 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCompare(model.id);
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              width: 14,
                              height: 14,
                              borderRadius: 2,
                              border: "1px solid var(--ink-line-strong)",
                              background: isCompared
                                ? "var(--bone)"
                                : "transparent",
                              color: "var(--ink-deep)",
                              fontSize: 10,
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {isCompared ? "✓" : ""}
                          </span>
                        </td>
                      ) : null}
                      <td style={{ color: "var(--bone)" }}>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            marginRight: 8,
                            verticalAlign: "middle",
                            backgroundColor:
                              PROVIDER_COLORS[model.provider] ??
                              "var(--bone-faint)",
                          }}
                        />
                        {model.name}
                      </td>
                      <td
                        className="font-mono"
                        style={{
                          color: "var(--bone-dim)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {model.provider}
                      </td>
                      <td className="num">{model.quality}%</td>
                      <td className="num">{model.speed}%</td>
                      <td className="num">
                        ${model.inputPrice.toFixed(2)} / $
                        {model.outputPrice.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashCard>
      </div>

      {/* Detail panel — either single-model detail or a side-by-side
          comparison of the 2-3 rows the user checked in compare mode. */}
      <div
        className="overflow-y-auto"
        style={{
          width: "45%",
          padding: "var(--space-6) var(--space-6)",
          borderLeft: "1px solid var(--ink-line)",
          background: "var(--ink-0)",
        }}
      >
        {compareMode && compared.size >= 2 ? (
          <ComparePanel
            models={rows.filter((r) => compared.has(r.id))}
            onUse={onModelSelect}
          />
        ) : compareMode ? (
          <EmptyState
            icon={<EmptyCompareMark />}
            heading={`Select ${2 - compared.size} more model${compared.size === 0 ? "s" : ""}`}
            description="Check 2 or 3 rows to see quality, speed, and pricing side-by-side. The winning column in each row highlights on its accent."
          />
        ) : selectedModel ? (
          <ModelDetail model={selectedModel} onSelect={onModelSelect} />
        ) : (
          <EmptyState
            icon={<EmptyDetailMark />}
            heading="Select a model"
            description="Click a row to see quality and speed curves, pricing, and the option to route future turns through it."
          />
        )}
      </div>
    </div>
  );
}

// ── Compare panel ───────────────────────────────────────────────────

function ComparePanel({
  models,
  onUse,
}: {
  models: ModelRow[];
  onUse?: (id: string, name: string, provider: string) => void;
}) {
  // Column-per-model, row-per-metric. Winners get a pearl-white highlight
  // so the dominant model on each row pops without adding color noise.
  const metrics: Array<{
    key: keyof ModelRow;
    label: string;
    direction: "higher" | "lower";
    format: (v: number) => string;
  }> = [
    {
      key: "quality",
      label: "Quality",
      direction: "higher",
      format: (v) => `${v}%`,
    },
    {
      key: "speed",
      label: "Speed",
      direction: "higher",
      format: (v) => `${v}%`,
    },
    {
      key: "inputPrice",
      label: "Input / 1M",
      direction: "lower",
      format: (v) => `$${v.toFixed(2)}`,
    },
    {
      key: "outputPrice",
      label: "Output / 1M",
      direction: "lower",
      format: (v) => `$${v.toFixed(2)}`,
    },
  ];

  const winnerIdFor = (key: keyof ModelRow, dir: "higher" | "lower") => {
    const values = models.map((m) => m[key] as number);
    const target = dir === "higher" ? Math.max(...values) : Math.min(...values);
    // If everyone ties, no winner (avoid highlighting every cell).
    if (values.every((v) => v === target)) return null;
    return models.find((m) => (m[key] as number) === target)?.id ?? null;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-5)",
      }}
    >
      <DashCard eyebrow="COMPARE" title={`Side-by-side (${models.length})`}>
        <table className="data-table" data-testid="compare-table">
          <thead>
            <tr>
              <th />
              {models.map((m) => (
                <th key={m.id} className="num" style={{ whiteSpace: "nowrap" }}>
                  <div
                    className="font-display"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--bone)",
                      textTransform: "none",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {m.name}
                  </div>
                  <div
                    className="font-mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--bone-mute)",
                      marginTop: 2,
                    }}
                  >
                    {m.provider}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => {
              const winnerId = winnerIdFor(metric.key, metric.direction);
              return (
                <tr key={metric.key as string}>
                  <td
                    className="font-mono"
                    style={{
                      color: "var(--bone-mute)",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      fontSize: "var(--text-2xs)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {metric.label}
                  </td>
                  {models.map((m) => {
                    const isWinner = m.id === winnerId;
                    return (
                      <td
                        key={m.id}
                        className="num"
                        data-winner={isWinner ? "true" : undefined}
                        style={{
                          color: isWinner ? "var(--bone)" : "var(--bone-dim)",
                          fontWeight: isWinner ? 600 : 400,
                          background: isWinner ? "var(--hi-haze)" : undefined,
                        }}
                      >
                        {metric.format(m[metric.key] as number)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </DashCard>

      <DashCard eyebrow="ACTIONS" title="Use one of these">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              className="br-btn"
              style={{ justifyContent: "space-between" }}
              onClick={() => onUse?.(m.id, m.name, m.provider)}
            >
              <span
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                }}
              >
                <span style={{ color: "var(--bone)" }}>{m.name}</span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--bone-mute)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  {m.provider}
                </span>
              </span>
              <span
                className="font-mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--bone-mute)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Use →
              </span>
            </button>
          ))}
        </div>
      </DashCard>
    </div>
  );
}

function EmptyCompareMark() {
  // Two overlapping rectangles — the "side-by-side" silhouette.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <rect
        x="14"
        y="22"
        width="34"
        height="44"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="40"
        y="22"
        width="34"
        height="44"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="currentColor"
        fillOpacity="0.08"
      />
      <line
        x1="21"
        y1="34"
        x2="41"
        y2="34"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.55"
      />
      <line
        x1="21"
        y1="42"
        x2="41"
        y2="42"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.45"
      />
      <line
        x1="21"
        y1="50"
        x2="41"
        y2="50"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.35"
      />
      <line
        x1="47"
        y1="34"
        x2="67"
        y2="34"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.55"
      />
      <line
        x1="47"
        y1="42"
        x2="67"
        y2="42"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.45"
      />
      <line
        x1="47"
        y1="50"
        x2="67"
        y2="50"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.35"
      />
    </svg>
  );
}

function Th({
  label,
  colKey,
  sortKey,
  sortDir,
  onSort,
  align,
}: {
  label: string;
  colKey: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = colKey === sortKey;
  return (
    <th
      data-sortable="true"
      onClick={() => onSort(colKey)}
      className={align === "right" ? "num" : undefined}
      style={{ whiteSpace: "nowrap" }}
    >
      {label}
      {active ? (
        <span style={{ marginLeft: 4, color: "var(--bone)" }}>
          {sortDir === "asc" ? "↑" : "↓"}
        </span>
      ) : null}
    </th>
  );
}

function ModelDetail({
  model,
  onSelect,
}: {
  model: ModelRow;
  onSelect?: (id: string, name: string, provider: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-5)",
      }}
    >
      <div>
        <div
          className="font-mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--bone-mute)",
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            marginBottom: 6,
          }}
        >
          {model.provider}
        </div>
        <div
          className="font-display"
          style={{
            fontSize: "var(--text-xl)",
            color: "var(--bone)",
            letterSpacing: "-0.02em",
          }}
        >
          {model.name}
        </div>
        <div
          className="font-mono"
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--bone-mute)",
            marginTop: 4,
          }}
        >
          {model.id}
        </div>
      </div>

      <DashCard eyebrow="METRICS" title="Quality & speed">
        <GaugeRow
          label="Quality"
          value={model.quality}
          accent="var(--sig-ok)"
        />
        <GaugeRow label="Speed" value={model.speed} accent="var(--sig-info)" />
      </DashCard>

      <DashCard eyebrow="PRICING" title="Per 1M tokens">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "var(--space-4)",
          }}
        >
          <PriceBlock label="Input" value={model.inputPrice} />
          <PriceBlock label="Output" value={model.outputPrice} />
        </div>
      </DashCard>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--bone-mute)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background:
              model.status === "available" ? "var(--sig-ok)" : "var(--sig-err)",
          }}
        />
        {model.status}
      </div>

      <button
        type="button"
        onClick={() => onSelect?.(model.id, model.name, model.provider)}
        data-testid="use-model"
        className="br-btn br-btn-primary"
        style={{ justifyContent: "center" }}
      >
        Use this model
      </button>
    </div>
  );
}

function GaugeRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        marginBottom: "var(--space-2)",
      }}
    >
      <span
        className="font-mono"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--bone-mute)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          width: 70,
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 4,
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--ink-3)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${value}%`,
            background: accent,
            transition: "width var(--duration-normal) var(--ease)",
          }}
        />
      </div>
      <span
        className="font-mono tabular-nums"
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--bone-dim)",
          width: 40,
          textAlign: "right",
        }}
      >
        {value}%
      </span>
    </div>
  );
}

function PriceBlock({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div
        className="font-mono"
        style={{
          fontSize: "var(--text-2xs)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--bone-mute)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="font-display tabular-nums"
        style={{
          fontSize: "var(--text-lg)",
          color: "var(--bone)",
          letterSpacing: "-0.02em",
        }}
      >
        ${value.toFixed(2)}
      </div>
    </div>
  );
}

function EmptyModelsMark() {
  // A spectrum of vertical bars — the model-ranking silhouette.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <rect
        x="12"
        y="28"
        width="6"
        height="40"
        fill="currentColor"
        fillOpacity="0.3"
      />
      <rect
        x="24"
        y="22"
        width="6"
        height="46"
        fill="currentColor"
        fillOpacity="0.45"
      />
      <rect
        x="36"
        y="34"
        width="6"
        height="34"
        fill="currentColor"
        fillOpacity="0.6"
      />
      <rect
        x="48"
        y="18"
        width="6"
        height="50"
        fill="currentColor"
        fillOpacity="0.75"
      />
      <rect
        x="60"
        y="26"
        width="6"
        height="42"
        fill="currentColor"
        fillOpacity="0.9"
      />
      <rect x="72" y="14" width="6" height="54" fill="currentColor" />
      <line
        x1="8"
        y1="72"
        x2="80"
        y2="72"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function EmptyDetailMark() {
  // Concentric rings — the "focus on one" silhouette.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <circle
        cx="44"
        cy="44"
        r="30"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.4"
      />
      <circle
        cx="44"
        cy="44"
        r="20"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.7"
      />
      <circle cx="44" cy="44" r="10" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="44" cy="44" r="3" fill="currentColor" />
    </svg>
  );
}
