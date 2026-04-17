/**
 * Workflows View — execute preset workflows and see results.
 */

import { useState, useEffect, useCallback } from "react";
import { request } from "../../lib/ipc-client";

interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  steps: number;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  name: string;
  request: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  error?: string;
}

export function WorkflowsView() {
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    request<WorkflowPreset[]>("workflow.presets")
      .then(setPresets)
      .catch(() => {});
  }, []);

  const executeWorkflow = useCallback(
    async (workflowId: string, userRequest: string) => {
      const preset = presets.find((p) => p.id === workflowId);
      const run: WorkflowRun = {
        id: `run-${Date.now()}`,
        workflowId,
        name: preset?.name ?? workflowId,
        request: userRequest,
        status: "running",
        startedAt: Date.now(),
      };

      setRuns((prev) => [run, ...prev]);
      setRunning(true);
      setActivePreset(null);
      setPromptInput("");

      try {
        await request("workflow.run", { workflowId, request: userRequest });
        setRuns((prev) =>
          prev.map((r) =>
            r.id === run.id ? { ...r, status: "completed" } : r,
          ),
        );
      } catch (e) {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === run.id
              ? {
                  ...r,
                  status: "failed",
                  error: e instanceof Error ? e.message : String(e),
                }
              : r,
          ),
        );
      }
      setRunning(false);
    },
    [presets],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden mode-crossfade">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ctp-surface0)]">
        <span className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
          Workflows
        </span>
        {running && (
          <span
            className="text-[10px] px-3 py-1 rounded-lg animate-pulse"
            style={{
              background: "var(--glow-mauve)",
              color: "var(--ctp-mauve)",
            }}
          >
            Running...
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Preset workflows from backend */}
        {presets.length > 0 && (
          <div>
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Preset Workflows ({presets.length})
            </div>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() =>
                    setActivePreset(
                      activePreset === preset.id ? null : preset.id,
                    )
                  }
                  data-testid={`workflow-preset-${preset.id}`}
                  className="interactive px-4 py-3 rounded-xl text-left"
                  style={{
                    background:
                      activePreset === preset.id
                        ? "var(--ctp-surface1)"
                        : "var(--ctp-surface0)",
                    border:
                      activePreset === preset.id
                        ? "1px solid var(--ctp-mauve)"
                        : "1px solid var(--border-subtle)",
                  }}
                >
                  <div
                    className="font-medium mb-1"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ctp-text)",
                    }}
                  >
                    {preset.name}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ctp-overlay0)",
                    }}
                  >
                    {preset.description || `${preset.steps} steps`}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Prompt input when a preset is selected */}
        {activePreset && (
          <div
            className="px-4 py-3 rounded-xl animate-fade-in"
            style={{
              background: "var(--ctp-surface0)",
              border: "1px solid var(--ctp-mauve)",
            }}
          >
            <div
              className="font-medium mb-2"
              style={{ fontSize: "var(--text-sm)", color: "var(--ctp-mauve)" }}
            >
              {presets.find((p) => p.id === activePreset)?.name}
            </div>
            <div className="flex gap-2">
              <input
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && promptInput.trim() && !running) {
                    executeWorkflow(activePreset, promptInput.trim());
                  }
                }}
                placeholder="Describe what you want to build..."
                disabled={running}
                data-testid="workflow-prompt"
                className="flex-1 px-3 py-2 rounded-lg"
                style={{
                  background: "var(--ctp-base)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--ctp-text)",
                  fontSize: "var(--text-xs)",
                  outline: "none",
                }}
              />
              <button
                onClick={() => {
                  if (promptInput.trim() && !running) {
                    executeWorkflow(activePreset, promptInput.trim());
                  }
                }}
                disabled={!promptInput.trim() || running}
                data-testid="workflow-run"
                className="interactive px-4 py-2 rounded-lg shrink-0"
                style={{
                  background:
                    promptInput.trim() && !running
                      ? "var(--ctp-mauve)"
                      : "var(--ctp-surface1)",
                  color:
                    promptInput.trim() && !running
                      ? "var(--ctp-crust)"
                      : "var(--ctp-overlay0)",
                  fontSize: "var(--text-xs)",
                  fontWeight: 500,
                }}
              >
                Run
              </button>
            </div>
          </div>
        )}

        {/* Execution history */}
        <div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Execution History ({runs.length})
          </div>
          {runs.length === 0 ? (
            <div
              className="text-center py-8"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              Select a preset above and describe your task to run a workflow.
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="px-4 py-3 rounded-xl"
                  style={{
                    background: "var(--ctp-surface0)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span
                        style={{
                          color:
                            run.status === "completed"
                              ? "var(--ctp-green)"
                              : run.status === "failed"
                                ? "var(--ctp-red)"
                                : "var(--ctp-mauve)",
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        {run.status === "completed"
                          ? "✓"
                          : run.status === "failed"
                            ? "✗"
                            : "◐"}
                      </span>
                      <span
                        className="font-medium"
                        style={{
                          fontSize: "var(--text-sm)",
                          color: "var(--ctp-text)",
                        }}
                      >
                        {run.name}
                      </span>
                    </div>
                    <span
                      className="font-mono"
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ctp-overlay0)",
                      }}
                    >
                      {new Date(run.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div
                    className="truncate"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ctp-subtext0)",
                    }}
                  >
                    {run.request}
                  </div>
                  {run.error && (
                    <div
                      className="mt-1"
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ctp-red)",
                      }}
                    >
                      {run.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
