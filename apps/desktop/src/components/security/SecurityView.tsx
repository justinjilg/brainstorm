/**
 * Security View — rebuilt on the BR component layer.
 *
 * Runs the red-team simulator via security.redteam, renders the scorecard
 * as BR StatCards + a category breakdown data-table. Middleware pipeline
 * is shown as a catalog inside a DashCard with an honest "status feed
 * not yet wired" footer — no fake green dots.
 */

import { useCallback, useState } from "react";
import { request } from "../../lib/ipc-client";
import { DashCard, EmptyState, PageHeader, StatCard, StatsRow } from "../br";

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

const MIDDLEWARE_LAYERS: Array<{ name: string; desc: string }> = [
  { name: "trust-propagation", desc: "Taint tracking across tool calls" },
  { name: "content-injection-filter", desc: "Web content sanitization" },
  { name: "tool-contract-enforcement", desc: "Argument validation" },
  { name: "tool-sequence-detector", desc: "Pattern matching on tool graph" },
  { name: "egress-monitor", desc: "Exfiltration blocking" },
  { name: "approval-friction", desc: "Velocity tracking" },
  { name: "security-scan", desc: "Credential + secret detection" },
  { name: "policy-validator", desc: "Injection / jailbreak detection" },
];

export function SecurityView() {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runRedTeam = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await request<Scorecard>("security.redteam", {
        generations: 5,
        populationSize: 30,
      });
      if (result) {
        setScorecard(result);
      } else {
        setError("Red team simulation failed — check server logs");
      }
    } catch {
      setError("Red team simulation failed — check server logs");
    }
    setRunning(false);
  }, []);

  return (
    <div
      className="flex-1 overflow-y-auto mode-crossfade"
      style={{
        background: "var(--ink-1)",
        padding: "var(--space-6) var(--space-8)",
      }}
    >
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <PageHeader
          title="Security"
          description="Run the evolutionary red-team simulator and see the catalog of middleware layers that defend every agent turn."
          actions={
            <button
              type="button"
              onClick={runRedTeam}
              disabled={running}
              data-testid="run-red-team"
              className="br-btn br-btn-primary"
            >
              {running ? "Running…" : "Run red team"}
            </button>
          }
        />

        {error ? (
          <DashCard eyebrow="ALERT" title="Simulation failed">
            <div
              style={{
                color: "var(--sig-err)",
                fontSize: "var(--text-sm)",
                padding: "var(--space-2) 0",
              }}
            >
              {error}
            </div>
          </DashCard>
        ) : null}

        {scorecard ? (
          <div className="home-stack animate-fade-in">
            <StatsRow>
              <StatCard
                label="Score"
                value={`${(scorecard.overallScore * 100).toFixed(0)}%`}
                accent={
                  scorecard.overallScore > 0.8
                    ? "success"
                    : scorecard.overallScore > 0.5
                      ? "warning"
                      : "danger"
                }
                tooltip="Fraction of attacks blocked across every category"
              />
              <StatCard
                label="Attacks"
                value={String(scorecard.totalAttacksTested)}
                accent="info"
                tooltip="Total attack genomes tested this run"
              />
              <StatCard
                label="Evasions"
                value={String(scorecard.totalEvasions)}
                accent={scorecard.totalEvasions === 0 ? "success" : "danger"}
                tooltip="Attacks that bypassed every middleware layer"
              />
              <StatCard
                label="Duration"
                value={`${scorecard.durationMs}ms`}
                accent="accent"
                tooltip="Wall-clock time for the run"
              />
            </StatsRow>

            <DashCard
              eyebrow="BREAKDOWN"
              title={`Category scorecard (${scorecard.categories.length})`}
            >
              <table className="data-table" data-testid="redteam-categories">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num" style={{ width: 100 }}>
                      Tested
                    </th>
                    <th className="num" style={{ width: 100 }}>
                      Blocked
                    </th>
                    <th className="num" style={{ width: 120 }}>
                      Evasion rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scorecard.categories.map((cat) => {
                    const secure = cat.evasionRate === 0;
                    return (
                      <tr key={cat.category}>
                        <td style={{ color: "var(--bone)" }}>{cat.category}</td>
                        <td className="num">{cat.totalAttacks}</td>
                        <td className="num">{cat.blocked}</td>
                        <td
                          className="num font-mono"
                          style={{
                            color: secure ? "var(--sig-ok)" : "var(--sig-err)",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            fontSize: "var(--text-2xs)",
                          }}
                        >
                          {secure
                            ? "SECURE"
                            : `${(cat.evasionRate * 100).toFixed(0)}% evade`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DashCard>
          </div>
        ) : running ? (
          <DashCard eyebrow="IN-FLIGHT" title="Evolutionary red team">
            <div
              className="animate-pulse-glow"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--bone-dim)",
                padding: "var(--space-6) 0",
                textAlign: "center",
              }}
            >
              Breeding attack genomes across generations…
            </div>
          </DashCard>
        ) : (
          <DashCard eyebrow="RED TEAM" title="No run yet">
            <EmptyState
              icon={<EmptyRedTeamMark />}
              heading="Haven't run the simulator yet"
              description="Click Run red team to breed attack genomes across 5 generations and test them against the middleware pipeline below."
              action={{ label: "Run red team", onClick: runRedTeam }}
            />
          </DashCard>
        )}

        <DashCard
          eyebrow="PIPELINE"
          title="Middleware catalog"
          note="Live per-session status isn't introspected — these are the layers that exist in packages/core. Need a middleware.status IPC to show real health."
        >
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Layer</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {MIDDLEWARE_LAYERS.map((layer, i) => (
                <tr key={layer.name} data-testid={`pipeline-layer-${i}`}>
                  <td
                    className="font-mono tabular-nums"
                    style={{ color: "var(--bone-mute)", width: 36 }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td
                    className="font-mono"
                    style={{ color: "var(--bone)", whiteSpace: "nowrap" }}
                  >
                    {layer.name}
                  </td>
                  <td>{layer.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DashCard>
      </div>
    </div>
  );
}

function EmptyRedTeamMark() {
  // Shield silhouette + thin radar sweep arcs — "defensive posture" cue.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <path
        d="M44 12 L68 22 L68 46 Q68 64 44 76 Q20 64 20 46 L20 22 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="currentColor"
        fillOpacity="0.08"
      />
      <path
        d="M32 40 L44 52 L58 32"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="44"
        cy="44"
        r="34"
        stroke="currentColor"
        strokeWidth="0.7"
        strokeOpacity="0.25"
      />
    </svg>
  );
}
