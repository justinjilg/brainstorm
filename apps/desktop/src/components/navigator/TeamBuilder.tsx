/**
 * Team Builder — compose agent teams with roles, models, and skills.
 * The team defines the execution context for plans and workflows.
 */

import { useState, useCallback } from "react";

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
  "product-manager": "var(--ctp-pink)",
  "security-reviewer": "var(--ctp-peach)",
  devops: "var(--ctp-sky)",
  orchestrator: "var(--ctp-lavender)",
  analyst: "var(--ctp-teal)",
};

const DEFAULT_SKILLS: Record<string, string[]> = {
  architect: [
    "planning-and-task-breakdown",
    "api-and-interface-design",
    "context-engineering",
  ],
  coder: [
    "incremental-implementation",
    "test-driven-development",
    "github-collaboration",
  ],
  reviewer: [
    "code-review-and-quality",
    "code-simplification",
    "performance-optimization",
  ],
  debugger: ["debugging-and-error-recovery", "test-driven-development"],
  qa: [
    "code-review-and-quality",
    "security-and-hardening",
    "debugging-and-error-recovery",
  ],
  "product-manager": ["planning-and-task-breakdown", "spec-driven-development"],
  devops: ["ci-cd-and-automation", "daemon-operations", "github-collaboration"],
};

const DEFAULT_MODELS: Record<string, { name: string; provider: string }> = {
  architect: { name: "Claude Opus 4.6", provider: "anthropic" },
  coder: { name: "Claude Sonnet 4.6", provider: "anthropic" },
  reviewer: { name: "GPT-5.4", provider: "openai" },
  debugger: { name: "Claude Sonnet 4.6", provider: "anthropic" },
  qa: { name: "Gemini 3.1 Flash", provider: "google" },
  "product-manager": { name: "Claude Opus 4.6", provider: "anthropic" },
  devops: { name: "DeepSeek V3", provider: "deepseek" },
};

export interface TeamAgent {
  id: string;
  role: string;
  model: string;
  provider: string;
  skills: string[];
  budget: number;
}

interface TeamBuilderProps {
  team: TeamAgent[];
  onTeamChange: (team: TeamAgent[]) => void;
  totalBudget: number;
}

export function TeamBuilder({
  team,
  onTeamChange,
  totalBudget,
}: TeamBuilderProps) {
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [nlInput, setNlInput] = useState("");

  const addAgent = useCallback(
    (role: string) => {
      const model = DEFAULT_MODELS[role] ?? {
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
      };
      const skills = DEFAULT_SKILLS[role] ?? [];
      const agent: TeamAgent = {
        id: `agent-${Date.now()}`,
        role,
        model: model.name,
        provider: model.provider,
        skills,
        budget: Math.max(0.5, (totalBudget - teamCost(team)) / 3),
      };
      onTeamChange([...team, agent]);
      setShowAddAgent(false);
    },
    [team, onTeamChange, totalBudget],
  );

  const removeAgent = useCallback(
    (id: string) => {
      onTeamChange(team.filter((a) => a.id !== id));
    },
    [team, onTeamChange],
  );

  const cost = teamCost(team);

  return (
    <div>
      <div
        className="px-4 py-2 flex items-center justify-between"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        <span>Team ({team.length})</span>
        <span
          className="font-mono"
          style={{
            color:
              cost > totalBudget * 0.8
                ? "var(--ctp-yellow)"
                : "var(--ctp-overlay0)",
          }}
        >
          ~${cost.toFixed(2)} / ${totalBudget.toFixed(2)}
        </span>
      </div>

      {/* Agent cards */}
      <div className="px-2 space-y-1">
        {team.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onRemove={() => removeAgent(agent.id)}
            onSkillAdd={(skill) => {
              onTeamChange(
                team.map((a) =>
                  a.id === agent.id
                    ? { ...a, skills: [...a.skills, skill] }
                    : a,
                ),
              );
            }}
            onSkillRemove={(skill) => {
              onTeamChange(
                team.map((a) =>
                  a.id === agent.id
                    ? { ...a, skills: a.skills.filter((s) => s !== skill) }
                    : a,
                ),
              );
            }}
          />
        ))}
      </div>

      {/* Add agent */}
      {showAddAgent ? (
        <div
          className="mx-2 mt-2 p-3 rounded-xl animate-fade-in"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-default)",
          }}
        >
          <div
            className="mb-2"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Add Agent
          </div>

          {/* NL input */}
          <input
            value={nlInput}
            data-testid="agent-nl-input"
            onChange={(e) => setNlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nlInput) {
                // Simple NL parsing — extract role keyword
                const roles = Object.keys(DEFAULT_MODELS);
                const found = roles.find((r) =>
                  nlInput.toLowerCase().includes(r),
                );
                if (found) addAgent(found);
              }
              if (e.key === "Escape") setShowAddAgent(false);
            }}
            placeholder='e.g. "coder using gpt-5.4"'
            autoFocus
            className="w-full bg-transparent outline-none mb-3 text-[var(--ctp-text)]"
            style={{ fontSize: "var(--text-xs)" }}
          />

          {/* Quick role buttons */}
          <div className="flex flex-wrap gap-1">
            {["architect", "coder", "reviewer", "qa", "debugger", "devops"].map(
              (role) => (
                <button
                  key={role}
                  onClick={() => addAgent(role)}
                  data-testid={`role-${role}`}
                  className="interactive px-2 py-1 rounded-lg"
                  style={{
                    fontSize: "var(--text-2xs)",
                    border: "1px solid var(--border-default)",
                    color: ROLE_COLORS[role] ?? "var(--ctp-overlay1)",
                  }}
                >
                  {role}
                </button>
              ),
            )}
          </div>

          <button
            onClick={() => setShowAddAgent(false)}
            className="interactive mt-2 w-full py-1 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="px-2 mt-2">
          <button
            onClick={() => setShowAddAgent(true)}
            data-testid="add-agent"
            className="interactive w-full flex items-center justify-center gap-1 py-2 rounded-xl"
            style={{
              border: "1px solid var(--border-default)",
              fontSize: "var(--text-xs)",
              color: "var(--ctp-subtext0)",
            }}
          >
            <span style={{ color: "var(--ctp-mauve)" }}>+</span>
            Add Agent
          </button>
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  onRemove,
  onSkillAdd,
  onSkillRemove,
}: {
  agent: TeamAgent;
  onRemove: () => void;
  onSkillAdd?: (skill: string) => void;
  onSkillRemove?: (skill: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const roleColor = ROLE_COLORS[agent.role] ?? "var(--ctp-overlay1)";
  const providerColor =
    PROVIDER_COLORS[agent.provider] ?? "var(--ctp-overlay0)";

  return (
    <div
      className="interactive px-3 py-2.5 rounded-xl group"
      data-testid={`agent-card-${agent.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("agent", JSON.stringify(agent));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("skill")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const skill = e.dataTransfer.getData("skill");
        if (skill && onSkillAdd && !agent.skills.includes(skill)) {
          onSkillAdd(skill);
        }
      }}
      style={{
        background: dragOver ? "var(--glow-mauve)" : "var(--ctp-surface0)",
        border: dragOver
          ? "1px solid var(--ctp-mauve)"
          : "1px solid var(--border-subtle)",
        cursor: "grab",
        transition: "all var(--duration-fast) var(--ease-out)",
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: roleColor }}
          />
          <span
            className="font-medium"
            style={{ fontSize: "var(--text-sm)", color: roleColor }}
          >
            {agent.role}
          </span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          data-testid={`remove-agent-${agent.id}`}
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
          }}
        >
          ✕
        </button>
      </div>

      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: providerColor }}
        />
        <span
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay1)" }}
        >
          {agent.model}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {agent.skills.map((skill) => (
          <span
            key={skill}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md group/skill"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay1)",
              background: "var(--ctp-crust)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            {skill.split("-").slice(0, 2).join("-")}
            {onSkillRemove && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSkillRemove(skill);
                }}
                className="opacity-0 group-hover/skill:opacity-100"
                style={{ fontSize: "8px", color: "var(--ctp-overlay0)" }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {dragOver && (
        <div
          className="mt-1 text-center py-1 rounded-md animate-fade-in"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-mauve)",
            border: "1px dashed var(--ctp-mauve)",
          }}
        >
          Drop skill here
        </div>
      )}
    </div>
  );
}

function teamCost(team: TeamAgent[]): number {
  return team.reduce((s, a) => s + a.budget, 0);
}
