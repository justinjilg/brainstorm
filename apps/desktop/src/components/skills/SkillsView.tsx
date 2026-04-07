/**
 * Skills View — browse, toggle, and create skills per role.
 */

import { useState } from "react";

interface Skill {
  name: string;
  description: string;
  active: boolean;
  source: "builtin" | "project" | "global";
}

const DEMO_SKILLS: Skill[] = [
  {
    name: "planning-and-task-breakdown",
    description: "Break work into phases, sprints, and tasks",
    active: true,
    source: "builtin",
  },
  {
    name: "context-engineering",
    description: "Optimize context window usage",
    active: true,
    source: "builtin",
  },
  {
    name: "incremental-implementation",
    description: "Build features incrementally",
    active: true,
    source: "builtin",
  },
  {
    name: "test-driven-development",
    description: "Write tests first",
    active: false,
    source: "builtin",
  },
  {
    name: "code-review-and-quality",
    description: "Review code for bugs and quality",
    active: false,
    source: "builtin",
  },
  {
    name: "security-and-hardening",
    description: "Security analysis and hardening",
    active: false,
    source: "builtin",
  },
  {
    name: "github-collaboration",
    description: "PR workflow, CI/CD, releases",
    active: true,
    source: "builtin",
  },
  {
    name: "performance-optimization",
    description: "Profile and optimize performance",
    active: false,
    source: "builtin",
  },
  {
    name: "debugging-and-error-recovery",
    description: "Systematic debugging approach",
    active: false,
    source: "builtin",
  },
  {
    name: "git-workflow-and-versioning",
    description: "Git best practices",
    active: true,
    source: "builtin",
  },
  {
    name: "api-and-interface-design",
    description: "Design clean APIs",
    active: false,
    source: "builtin",
  },
  {
    name: "frontend-ui-engineering",
    description: "Build frontend UIs",
    active: false,
    source: "builtin",
  },
  {
    name: "documentation-and-adrs",
    description: "Write docs and architecture decisions",
    active: false,
    source: "builtin",
  },
  {
    name: "daemon-operations",
    description: "KAIROS tick protocol",
    active: false,
    source: "builtin",
  },
  {
    name: "godmode-operations",
    description: "ChangeSet protocol",
    active: false,
    source: "builtin",
  },
];

export function SkillsView() {
  const [skills, setSkills] = useState(DEMO_SKILLS);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const selected = skills.find((s) => s.name === selectedName);
  const activeCount = skills.filter((s) => s.active).length;

  const toggleSkill = (name: string) => {
    setSkills((prev) =>
      prev.map((s) => (s.name === name ? { ...s, active: !s.active } : s)),
    );
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Skill list */}
      <div className="w-[55%] border-r border-[var(--ctp-surface0)] flex flex-col overflow-hidden">
        <div className="px-4 py-2 border-b border-[var(--ctp-surface0)]">
          <span className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
            Skills ({skills.length}) · {activeCount} active
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Active skills */}
          <div className="p-2">
            <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider px-2 py-1">
              Active
            </div>
            {skills
              .filter((s) => s.active)
              .map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  isSelected={selectedName === skill.name}
                  onSelect={() => setSelectedName(skill.name)}
                  onToggle={() => toggleSkill(skill.name)}
                />
              ))}
          </div>

          {/* Available skills */}
          <div className="p-2">
            <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider px-2 py-1">
              Available
            </div>
            {skills
              .filter((s) => !s.active)
              .map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  isSelected={selectedName === skill.name}
                  onSelect={() => setSelectedName(skill.name)}
                  onToggle={() => toggleSkill(skill.name)}
                />
              ))}
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-t border-[var(--ctp-surface0)]">
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
            + Import Skill
          </button>
          <button className="text-[10px] px-2 py-1 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
            Create New
          </button>
        </div>
      </div>

      {/* Skill detail */}
      <div className="w-[45%] overflow-y-auto p-4">
        {selected ? (
          <div className="space-y-4">
            <div>
              <div className="text-lg font-medium text-[var(--ctp-text)] mb-1">
                {selected.name}
              </div>
              <div className="text-xs text-[var(--ctp-overlay0)]">
                {selected.description}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)]">
                {selected.source}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded ${
                  selected.active
                    ? "bg-[var(--ctp-green)]/20 text-[var(--ctp-green)]"
                    : "bg-[var(--ctp-surface0)] text-[var(--ctp-overlay0)]"
                }`}
              >
                {selected.active ? "Active" : "Inactive"}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-[var(--ctp-surface0)] text-sm text-[var(--ctp-overlay1)]">
              Full SKILL.md content would render here with syntax highlighting.
              Click "Edit" to modify the skill definition.
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--ctp-overlay0)]">
            Select a skill to view details
          </div>
        )}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  isSelected,
  onSelect,
  onToggle,
}: {
  skill: Skill;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? "bg-[var(--ctp-surface0)]"
          : "hover:bg-[var(--ctp-surface0)]/50"
      }`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${
          skill.active
            ? "border-[var(--ctp-green)] bg-[var(--ctp-green)] text-[var(--ctp-crust)]"
            : "border-[var(--ctp-surface2)] hover:border-[var(--ctp-overlay0)]"
        }`}
      >
        {skill.active ? "✓" : ""}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-[var(--ctp-text)] truncate">
          {skill.name}
        </div>
        <div className="text-[10px] text-[var(--ctp-overlay0)] truncate">
          {skill.description}
        </div>
      </div>
    </div>
  );
}
