/**
 * Security View — wired to real red team engine via server API.
 */

import { useState, useCallback } from "react";
import { getClient } from "../../lib/api-client";

interface CategoryScore {
  category: string;
  totalAttacks: number;
  blocked: number;
  evaded: number;
  evasionRate: number;
}

interface Scorecard {
  overallScore: number;
  categories: CategoryScore[];
  totalAttacksTested: number;
  totalEvasions: number;
  generations: number;
  durationMs: number;
}

export function SecurityView() {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runRedTeam = useCallback(async () => {
    setRunning(true);
    setError(null);
    const client = getClient();
    const result = await client.runRedTeam({
      generations: 5,
      populationSize: 30,
    });
    if (result) {
      setScorecard(result);
    } else {
      setError("Red team simulation failed — check server logs");
    }
    setRunning(false);
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--ctp-base)]">
      <div
        className="flex items-center justify-between px-6 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Security Dashboard
        </span>
        <button
          onClick={runRedTeam}
          disabled={running}
          className="interactive px-4 py-1.5 rounded-lg disabled:opacity-40"
          style={{
            fontSize: "var(--text-xs)",
            background: "var(--ctp-mauve)",
            color: "var(--ctp-crust)",
          }}
        >
          {running ? "Running..." : "Run Red Team"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[720px] mx-auto space-y-6">
          {error && (
            <div
              className="p-3 rounded-xl animate-fade-in"
              style={{
                background: "var(--glow-red)",
                border: "1px solid rgba(243, 139, 168, 0.2)",
                fontSize: "var(--text-xs)",
                color: "var(--ctp-red)",
              }}
            >
              {error}
            </div>
          )}

          {/* Scorecard */}
          {scorecard ? (
            <div className="animate-fade-in space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-4 gap-4">
                <StatCard
                  label="Score"
                  value={`${(scorecard.overallScore * 100).toFixed(0)}%`}
                  color={
                    scorecard.overallScore > 0.8
                      ? "var(--ctp-green)"
                      : scorecard.overallScore > 0.5
                        ? "var(--ctp-yellow)"
                        : "var(--ctp-red)"
                  }
                />
                <StatCard
                  label="Attacks"
                  value={String(scorecard.totalAttacksTested)}
                />
                <StatCard
                  label="Evasions"
                  value={String(scorecard.totalEvasions)}
                  color={
                    scorecard.totalEvasions > 0
                      ? "var(--ctp-red)"
                      : "var(--ctp-green)"
                  }
                />
                <StatCard
                  label="Duration"
                  value={`${scorecard.durationMs}ms`}
                />
              </div>

              {/* Categories */}
              <div>
                <SectionHeader title="Category Breakdown" />
                <div className="mt-3 space-y-2">
                  {scorecard.categories.map((cat) => (
                    <div
                      key={cat.category}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl"
                      style={{
                        background: "var(--ctp-surface0)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      <span
                        className="flex-1"
                        style={{
                          fontSize: "var(--text-sm)",
                          color: "var(--ctp-text)",
                        }}
                      >
                        {cat.category}
                      </span>
                      <div
                        className="rounded-full overflow-hidden"
                        style={{
                          width: 100,
                          height: 4,
                          background: "var(--ctp-crust)",
                        }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(1 - cat.evasionRate) * 100}%`,
                            background:
                              cat.evasionRate === 0
                                ? "var(--ctp-green)"
                                : "var(--ctp-red)",
                          }}
                        />
                      </div>
                      <span
                        className="w-20 text-right font-mono"
                        style={{
                          fontSize: "var(--text-2xs)",
                          color:
                            cat.evasionRate === 0
                              ? "var(--ctp-green)"
                              : "var(--ctp-red)",
                        }}
                      >
                        {cat.evasionRate === 0
                          ? "SECURE"
                          : `${(cat.evasionRate * 100).toFixed(0)}% evade`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            !running && (
              <div
                className="text-center py-12"
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                Click "Run Red Team" to generate an adversarial defense
                scorecard. The engine breeds {30} attack genomes across {5}{" "}
                generations and tests them against the 8-layer middleware
                pipeline.
              </div>
            )
          )}

          {running && (
            <div
              className="text-center py-12 animate-pulse-glow"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ctp-mauve)",
              }}
            >
              Running evolutionary red team simulation...
            </div>
          )}

          {/* Middleware Pipeline (always shown) */}
          <div>
            <SectionHeader title="Middleware Pipeline (8 layers)" />
            <div className="mt-3 space-y-1.5">
              {[
                { name: "trust-propagation", desc: "Taint tracking" },
                {
                  name: "content-injection-filter",
                  desc: "Web content sanitization",
                },
                {
                  name: "tool-contract-enforcement",
                  desc: "Argument validation",
                },
                { name: "tool-sequence-detector", desc: "Pattern matching" },
                { name: "egress-monitor", desc: "Exfiltration blocking" },
                { name: "approval-friction", desc: "Velocity tracking" },
                { name: "security-scan", desc: "Credential detection" },
                { name: "policy-validator", desc: "Injection detection" },
              ].map((layer, i) => (
                <div
                  key={layer.name}
                  className="flex items-center gap-3 px-4 py-2 rounded-xl"
                  style={{
                    background: "var(--ctp-surface0)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center font-medium"
                    style={{
                      fontSize: "var(--text-2xs)",
                      background: "var(--glow-green)",
                      color: "var(--ctp-green)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    className="font-mono flex-1"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ctp-text)",
                    }}
                  >
                    {layer.name}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ctp-overlay0)",
                    }}
                  >
                    {layer.desc}
                  </span>
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: "var(--ctp-green)" }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      className="p-4 rounded-xl"
      style={{
        background: "var(--ctp-surface0)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="font-mono font-medium"
        style={{
          fontSize: "var(--text-lg)",
          color: color ?? "var(--ctp-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        fontSize: "var(--text-2xs)",
        color: "var(--ctp-overlay0)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {title}
    </div>
  );
}
