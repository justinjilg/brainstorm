/**
 * Plan View — visual execution of multi-phase plans.
 * Shows phases as a pipeline, tasks within each phase, agent assignments,
 * cost tracking, and approval gates.
 */

import { useState } from "react";

export type PlanStatus =
  | "idle"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed";
export type PhaseStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface PlanTask {
  id: string;
  description: string;
  status: TaskStatus;
  agentRole: string;
  model: string;
  provider: string;
  cost: number;
  toolCalls: number;
  worktree?: string;
  output?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PlanPhase {
  id: string;
  name: string;
  status: PhaseStatus;
  tasks: PlanTask[];
  cost: number;
}

export interface Plan {
  id: string;
  title: string;
  status: PlanStatus;
  phases: PlanPhase[];
  totalCost: number;
  budget: number;
  startedAt?: number;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
};

const ROLE_COLORS: Record<string, string> = {
  architect: "var(--ctp-mauve)",
  coder: "var(--ctp-green)",
  reviewer: "var(--ctp-yellow)",
  debugger: "var(--ctp-peach)",
  qa: "var(--ctp-red)",
  devops: "var(--ctp-sky)",
};

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending: { icon: "○", color: "var(--ctp-overlay0)" },
  running: { icon: "◐", color: "var(--ctp-mauve)" },
  completed: { icon: "✓", color: "var(--ctp-green)" },
  failed: { icon: "✗", color: "var(--ctp-red)" },
  blocked: { icon: "◻", color: "var(--ctp-yellow)" },
  skipped: { icon: "—", color: "var(--ctp-overlay0)" },
  idle: { icon: "○", color: "var(--ctp-overlay0)" },
  planning: { icon: "◐", color: "var(--ctp-blue)" },
  paused: { icon: "⏸", color: "var(--ctp-yellow)" },
};

interface PlanViewProps {
  plan: Plan | null;
  onTaskSelect: (taskId: string) => void;
  onApprove: (phaseId: string) => void;
  onPause: () => void;
  onResume: () => void;
}

export function PlanView({
  plan,
  onTaskSelect,
  onApprove,
  onPause,
  onResume,
}: PlanViewProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  if (!plan) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--ctp-base)]">
        <div className="text-center animate-fade-in">
          <div
            className="tracking-[0.2em] uppercase font-semibold mb-3"
            style={{ fontSize: "var(--text-lg)", color: "var(--ctp-overlay1)" }}
          >
            Plan Execution
          </div>
          <div
            className="mb-6 max-w-md"
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-overlay0)" }}
          >
            Send a complex prompt in Chat to generate a multi-phase execution
            plan. Your team will be assigned to phases automatically.
          </div>
          <div
            className="flex items-center justify-center gap-2"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            <span>⌘1 Chat</span>
            <span>·</span>
            <span>Define team in Navigator</span>
            <span>·</span>
            <span>Type a complex request</span>
          </div>
        </div>
      </div>
    );
  }

  const planStatus = STATUS_ICONS[plan.status] ?? STATUS_ICONS.idle;
  const completedPhases = plan.phases.filter(
    (p) => p.status === "completed",
  ).length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--ctp-base)]">
      {/* Plan header */}
      <div
        className="flex items-center justify-between px-6 py-3 shrink-0"
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--ctp-mantle)",
        }}
      >
        <div className="flex items-center gap-3">
          <span style={{ color: planStatus.color }}>{planStatus.icon}</span>
          <div>
            <div
              className="font-medium"
              style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
            >
              {plan.title}
            </div>
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              {completedPhases}/{plan.phases.length} phases · $
              {plan.totalCost.toFixed(2)} / ${plan.budget.toFixed(2)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {plan.status === "running" && (
            <button
              onClick={onPause}
              className="interactive px-3 py-1.5 rounded-lg"
              style={{
                fontSize: "var(--text-xs)",
                border: "1px solid var(--border-default)",
                color: "var(--ctp-yellow)",
              }}
            >
              Pause
            </button>
          )}
          {plan.status === "paused" && (
            <button
              onClick={onResume}
              className="interactive px-3 py-1.5 rounded-lg"
              style={{
                fontSize: "var(--text-xs)",
                background: "var(--ctp-mauve)",
                color: "var(--ctp-crust)",
              }}
            >
              Resume
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: "var(--ctp-surface0)" }}>
        <div
          style={{
            height: "100%",
            width: `${(completedPhases / Math.max(plan.phases.length, 1)) * 100}%`,
            background: "var(--ctp-mauve)",
            transition: "width var(--duration-slow) var(--ease-out)",
          }}
        />
      </div>

      {/* Phase pipeline */}
      <div className="overflow-x-auto px-6 py-4">
        <div className="flex items-start gap-3">
          {plan.phases.map((phase, i) => (
            <div key={phase.id} className="flex items-start gap-3">
              <PhaseCard
                phase={phase}
                selectedTaskId={selectedTaskId}
                onTaskSelect={(id) => {
                  setSelectedTaskId(id);
                  onTaskSelect(id);
                }}
                onApprove={() => onApprove(phase.id)}
              />
              {i < plan.phases.length - 1 && (
                <div
                  className="shrink-0 mt-8"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ctp-surface2)",
                  }}
                >
                  →
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Selected task detail */}
      {selectedTaskId && (
        <div
          className="flex-1 overflow-y-auto px-6 pb-4"
          style={{ borderTop: "1px solid var(--border-subtle)" }}
        >
          <TaskDetail task={findTask(plan, selectedTaskId)} />
        </div>
      )}
    </div>
  );
}

function PhaseCard({
  phase,
  selectedTaskId,
  onTaskSelect,
  onApprove,
}: {
  phase: PlanPhase;
  selectedTaskId: string | null;
  onTaskSelect: (id: string) => void;
  onApprove: () => void;
}) {
  const status = STATUS_ICONS[phase.status] ?? STATUS_ICONS.pending;
  const isRunning = phase.status === "running";

  return (
    <div
      className="shrink-0 rounded-2xl overflow-hidden"
      style={{
        width: 240,
        background: "var(--ctp-surface0)",
        border: isRunning
          ? "1px solid var(--ctp-mauve)"
          : "1px solid var(--border-subtle)",
        boxShadow: isRunning ? "0 0 20px rgba(203, 166, 247, 0.1)" : "none",
      }}
    >
      {/* Phase header */}
      <div
        className="px-4 py-3"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        <div className="flex items-center justify-between mb-1">
          <span
            className="font-medium"
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
          >
            {phase.name}
          </span>
          <span style={{ color: status.color, fontSize: "var(--text-sm)" }}>
            {status.icon}
          </span>
        </div>
        <div
          className="flex items-center gap-2"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          <span>{phase.tasks.length} tasks</span>
          <span>·</span>
          <span className="font-mono">${phase.cost.toFixed(2)}</span>
        </div>
      </div>

      {/* Tasks */}
      <div className="p-2 space-y-1">
        {phase.tasks.map((task) => {
          const taskStatus = STATUS_ICONS[task.status] ?? STATUS_ICONS.pending;
          const roleColor =
            ROLE_COLORS[task.agentRole] ?? "var(--ctp-overlay1)";
          const provColor =
            PROVIDER_COLORS[task.provider] ?? "var(--ctp-overlay0)";
          const isSelected = selectedTaskId === task.id;

          return (
            <div
              key={task.id}
              onClick={() => onTaskSelect(task.id)}
              className="interactive px-3 py-2 rounded-xl"
              style={{
                background: isSelected
                  ? "var(--surface-elevated)"
                  : "transparent",
                border: isSelected
                  ? "1px solid var(--border-default)"
                  : "1px solid transparent",
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={
                    task.status === "running" ? "animate-pulse-glow" : ""
                  }
                  style={{
                    color: taskStatus.color,
                    fontSize: "var(--text-xs)",
                  }}
                >
                  {taskStatus.icon}
                </span>
                <span
                  className="truncate flex-1"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ctp-text)",
                  }}
                >
                  {task.description}
                </span>
              </div>
              <div
                className="flex items-center gap-2 ml-4"
                style={{ fontSize: "var(--text-2xs)" }}
              >
                <span style={{ color: roleColor }}>{task.agentRole}</span>
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: provColor }}
                />
                <span className="font-mono text-[var(--ctp-overlay0)]">
                  ${task.cost.toFixed(3)}
                </span>
                {task.toolCalls > 0 && (
                  <span className="text-[var(--ctp-overlay0)]">
                    {task.toolCalls}t
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Approval gate (shown when phase needs approval) */}
      {phase.status === "running" &&
        phase.tasks.every((t) => t.status === "completed") && (
          <div className="px-3 pb-3 animate-fade-in">
            <button
              onClick={onApprove}
              className="interactive w-full py-2 rounded-xl font-medium"
              style={{
                fontSize: "var(--text-xs)",
                background: "var(--ctp-green)",
                color: "var(--ctp-crust)",
              }}
            >
              Approve Phase
            </button>
          </div>
        )}
    </div>
  );
}

function TaskDetail({ task }: { task: PlanTask | null }) {
  if (!task) return null;

  const status = STATUS_ICONS[task.status] ?? STATUS_ICONS.pending;
  const roleColor = ROLE_COLORS[task.agentRole] ?? "var(--ctp-overlay1)";

  return (
    <div className="py-4 animate-fade-in">
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: status.color }}>{status.icon}</span>
        <span
          className="font-medium"
          style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
        >
          {task.description}
        </span>
      </div>

      <div
        className="grid grid-cols-4 gap-4 mb-4"
        style={{ fontSize: "var(--text-xs)" }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Agent
          </div>
          <div style={{ color: roleColor }}>{task.agentRole}</div>
        </div>
        <div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Model
          </div>
          <div style={{ color: "var(--ctp-subtext1)" }}>{task.model}</div>
        </div>
        <div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Cost
          </div>
          <div className="font-mono" style={{ color: "var(--ctp-text)" }}>
            ${task.cost.toFixed(4)}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Tools
          </div>
          <div style={{ color: "var(--ctp-text)" }}>{task.toolCalls} calls</div>
        </div>
      </div>

      {task.worktree && (
        <div
          className="px-3 py-2 rounded-xl mb-3"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-2xs)",
          }}
        >
          <span className="text-[var(--ctp-overlay0)]">Worktree: </span>
          <span className="font-mono text-[var(--ctp-subtext1)]">
            {task.worktree}
          </span>
        </div>
      )}

      {task.output && (
        <div
          className="p-4 rounded-xl whitespace-pre-wrap"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay1)",
            lineHeight: "1.6",
            maxHeight: 300,
            overflow: "auto",
          }}
        >
          {task.output}
        </div>
      )}
    </div>
  );
}

function findTask(plan: Plan, taskId: string): PlanTask | null {
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      if (task.id === taskId) return task;
    }
  }
  return null;
}
