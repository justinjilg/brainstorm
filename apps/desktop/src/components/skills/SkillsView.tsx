/**
 * Skills View — wired to real BrainstormServer skills API.
 */

import { useState } from "react";
import { useSkills } from "../../hooks/useServerData";

export function SkillsView() {
  const { skills, loading } = useSkills();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activeSkills, setActiveSkills] = useState<Set<string>>(new Set());

  const selected = skills.find((s) => s.name === selectedName);
  const activeCount = activeSkills.size;

  const toggleSkill = (name: string) => {
    setActiveSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="flex-1 flex overflow-hidden bg-[var(--ctp-base)]">
      {/* Skill list */}
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: "55%",
          borderRight: "1px solid var(--border-subtle)",
        }}
      >
        <div
          className="px-4 py-2"
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Skills ({skills.length}) · {activeCount} active
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div
              className="p-4 animate-pulse-glow"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ctp-overlay1)",
              }}
            >
              Loading skills...
            </div>
          ) : skills.length === 0 ? (
            <div
              className="p-4 text-center"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              No skills loaded
            </div>
          ) : (
            skills.map((skill) => (
              <div
                key={skill.name}
                onClick={() => setSelectedName(skill.name)}
                className="interactive flex items-center gap-3 px-4 py-3"
                style={{
                  borderBottom: "1px solid var(--border-subtle)",
                  background:
                    selectedName === skill.name
                      ? "var(--ctp-surface0)"
                      : "transparent",
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSkill(skill.name);
                  }}
                  className="interactive w-4 h-4 rounded border flex items-center justify-center shrink-0"
                  style={{
                    fontSize: "var(--text-2xs)",
                    borderColor: activeSkills.has(skill.name)
                      ? "var(--ctp-green)"
                      : "var(--ctp-surface2)",
                    background: activeSkills.has(skill.name)
                      ? "var(--ctp-green)"
                      : "transparent",
                    color: "var(--ctp-crust)",
                  }}
                >
                  {activeSkills.has(skill.name) ? "✓" : ""}
                </button>
                <div className="flex-1 min-w-0">
                  <div
                    className="truncate"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ctp-text)",
                    }}
                  >
                    {skill.name}
                  </div>
                  <div
                    className="truncate"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ctp-overlay0)",
                    }}
                  >
                    {skill.description}
                  </div>
                </div>
                <span
                  className="px-1.5 py-0.5 rounded-md shrink-0"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ctp-overlay0)",
                    background: "var(--ctp-surface0)",
                  }}
                >
                  {skill.source}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Skill detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {selected ? (
          <div className="animate-fade-in space-y-4">
            <div>
              <div
                className="font-medium mb-1"
                style={{
                  fontSize: "var(--text-lg)",
                  color: "var(--ctp-text)",
                }}
              >
                {selected.name}
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                {selected.description}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-0.5 rounded-md"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay1)",
                  background: "var(--ctp-surface0)",
                }}
              >
                {selected.source}
              </span>
              <span
                className="px-2 py-0.5 rounded-md"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: activeSkills.has(selected.name)
                    ? "var(--ctp-green)"
                    : "var(--ctp-overlay0)",
                  background: activeSkills.has(selected.name)
                    ? "var(--glow-green)"
                    : "var(--ctp-surface0)",
                }}
              >
                {activeSkills.has(selected.name) ? "Active" : "Inactive"}
              </span>
            </div>
            <div
              className="p-4 rounded-xl whitespace-pre-wrap"
              style={{
                background: "var(--ctp-surface0)",
                border: "1px solid var(--border-subtle)",
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay1)",
                lineHeight: "1.6",
                maxHeight: 400,
                overflow: "auto",
              }}
            >
              {selected.content || "No content preview available"}
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-center h-full"
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Select a skill to view details
          </div>
        )}
      </div>
    </div>
  );
}
