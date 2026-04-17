/**
 * Plan View — run a preset workflow and see its output.
 *
 * Previous version rendered a ~640-line fake phase/task/approval pipeline
 * that looked live but wasn't: pause/resume only mutated local state,
 * onApprove was an empty function, cost and budget were always 0, and
 * the task list was always []. The backend's workflow.run call just
 * returns when done — there is no streaming phase signal yet, no
 * per-step cost, no approval gate plumbing. The fancy UI made the
 * product look broken because nothing in it reflected reality.
 *
 * Until the backend ships a `workflow.stream` IPC that actually emits
 * per-phase progress, the honest version is small: pick a preset, type
 * a prompt, run, watch a spinner, see the output. WorkflowsView does
 * essentially the same thing — this view keeps a slightly different
 * framing (emphasis on the request, running as a focused "plan" step)
 * and stays a stub for the richer UI that phase-streaming will enable.
 */

import { useState, useCallback, useEffect } from "react";
import { request } from "../../lib/ipc-client";

interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  steps: number;
}

interface RunState {
  id: string;
  presetId: string;
  presetName: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  output?: string;
  error?: string;
  startedAt: number;
}

export function PlanView() {
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [currentRun, setCurrentRun] = useState<RunState | null>(null);
  const [history, setHistory] = useState<RunState[]>([]);

  // Load presets from backend on mount.
  useEffect(() => {
    request<WorkflowPreset[]>("workflow.presets")
      .then((p) => {
        setPresets(p);
        setPresetsError(null);
      })
      .catch((err) => {
        setPresetsError(
          err instanceof Error ? err.message : "Failed to load presets",
        );
      });
  }, []);

  const activePreset = presets.find((p) => p.id === activePresetId) ?? null;

  const runPlan = useCallback(async () => {
    if (!activePreset || !prompt.trim() || currentRun?.status === "running") {
      return;
    }
    const runId = `run-${Date.now()}`;
    const run: RunState = {
      id: runId,
      presetId: activePreset.id,
      presetName: activePreset.name,
      prompt: prompt.trim(),
      status: "running",
      startedAt: Date.now(),
    };
    setCurrentRun(run);

    try {
      const result = await request<{ output?: string }>("workflow.run", {
        workflowId: activePreset.id,
        request: prompt.trim(),
      });
      const completed: RunState = {
        ...run,
        status: "completed",
        output: result?.output ?? "(no output)",
      };
      setCurrentRun(completed);
      setHistory((h) => [completed, ...h].slice(0, 10));
    } catch (err) {
      const failed: RunState = {
        ...run,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      setCurrentRun(failed);
      setHistory((h) => [failed, ...h].slice(0, 10));
    }
  }, [activePreset, prompt, currentRun]);

  const isRunning = currentRun?.status === "running";

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden mode-crossfade bg-[var(--ctp-base)]"
      data-testid="plan-view"
    >
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-10">
          <div
            className="tracking-[0.2em] uppercase font-semibold mb-3"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Plan
          </div>
          <div
            className="mb-6"
            style={{
              fontSize: "var(--text-lg)",
              color: "var(--ctp-text)",
            }}
          >
            Run a preset workflow against a task.
          </div>

          {/* Preset picker */}
          {presetsError && (
            <div
              data-testid="plan-presets-error"
              className="mb-4 px-3 py-2 rounded-lg"
              style={{
                background: "var(--glow-red)",
                color: "var(--ctp-red)",
                fontSize: "var(--text-2xs)",
                border: "1px solid var(--ctp-red)",
              }}
            >
              Could not load presets: {presetsError}
            </div>
          )}

          <div
            className="tracking-[0.12em] uppercase mb-2"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Preset
          </div>
          <div className="flex flex-wrap gap-2 mb-5">
            {presets.length === 0 && !presetsError && (
              <span
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                Loading presets…
              </span>
            )}
            {presets.map((p) => {
              const selected = p.id === activePresetId;
              return (
                <button
                  key={p.id}
                  onClick={() => setActivePresetId(p.id)}
                  data-testid={`plan-preset-${p.id}`}
                  className="interactive px-3 py-1.5 rounded-lg"
                  title={p.description}
                  style={{
                    fontSize: "var(--text-xs)",
                    background: selected
                      ? "var(--ctp-mauve)"
                      : "var(--ctp-surface0)",
                    color: selected
                      ? "var(--ctp-crust)"
                      : "var(--ctp-subtext1)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  {p.name}{" "}
                  <span
                    style={{
                      opacity: 0.6,
                      marginLeft: 4,
                    }}
                  >
                    · {p.steps} step{p.steps === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Prompt */}
          <div
            className="tracking-[0.12em] uppercase mb-2"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Task
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              activePreset
                ? `What should "${activePreset.name}" do?`
                : "Pick a preset above first."
            }
            disabled={!activePreset || isRunning}
            rows={4}
            data-testid="plan-prompt"
            className="w-full bg-transparent resize-none outline-none rounded-xl px-4 py-3 mb-3"
            style={{
              border: "1px solid var(--border-subtle)",
              background: "var(--ctp-surface0)",
              color: "var(--ctp-text)",
              fontSize: "var(--text-sm)",
            }}
          />

          <div className="flex items-center justify-between mb-6">
            <span
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              Runs synchronously — phase streaming is future work.
            </span>
            <button
              onClick={runPlan}
              disabled={!activePreset || !prompt.trim() || isRunning}
              data-testid="plan-run"
              className="interactive px-4 py-2 rounded-lg disabled:opacity-40"
              style={{
                fontSize: "var(--text-xs)",
                background: "var(--ctp-green)",
                color: "var(--ctp-crust)",
                fontWeight: 500,
              }}
            >
              {isRunning ? "Running…" : "Run"}
            </button>
          </div>

          {/* Current run */}
          {currentRun && (
            <RunCard run={currentRun} testIdPrefix="plan-current" />
          )}

          {/* History */}
          {history.length > 1 && (
            <div className="mt-8">
              <div
                className="tracking-[0.12em] uppercase mb-2"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                Recent runs
              </div>
              <div className="space-y-2">
                {history.slice(1).map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    testIdPrefix={`plan-history-${run.id}`}
                    compact
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunCard({
  run,
  testIdPrefix,
  compact = false,
}: {
  run: RunState;
  testIdPrefix: string;
  compact?: boolean;
}) {
  const statusColor =
    run.status === "running"
      ? "var(--ctp-mauve)"
      : run.status === "completed"
        ? "var(--ctp-green)"
        : "var(--ctp-red)";
  return (
    <div
      data-testid={testIdPrefix}
      className="rounded-xl overflow-hidden"
      style={{
        background: "var(--ctp-surface0)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <span
            className={run.status === "running" ? "animate-pulse-glow" : ""}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor,
              display: "inline-block",
            }}
          />
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ctp-text)",
              fontWeight: 500,
            }}
          >
            {run.presetName}
          </span>
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            {new Date(run.startedAt).toLocaleTimeString()}
          </span>
        </div>
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: statusColor,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          {run.status}
        </span>
      </div>
      {!compact && (
        <div
          className="px-4 py-3"
          style={{
            borderTop: "1px solid var(--border-subtle)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-subtext1)",
            whiteSpace: "pre-wrap",
            fontFamily: "var(--font-mono)",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {run.status === "failed"
            ? `✗ ${run.error ?? "Unknown error"}`
            : run.output || "(waiting for output…)"}
        </div>
      )}
    </div>
  );
}
