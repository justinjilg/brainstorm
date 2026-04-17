/**
 * Role Picker — dropdown for switching agent personas.
 * Each role maps to a curated skill set that shapes the agent's behavior.
 */

import { useState, useEffect, useRef } from "react";

interface Role {
  id: string;
  label: string;
  description: string;
  skills: string[];
  color: string;
}

const ROLES: Role[] = [
  {
    id: "architect",
    label: "Architect",
    description: "System design, API design, planning",
    skills: [
      "planning-and-task-breakdown",
      "api-and-interface-design",
      "context-engineering",
    ],
    color: "var(--ctp-mauve)",
  },
  {
    id: "developer",
    label: "Developer",
    description: "Implementation, coding, refactoring",
    skills: [
      "incremental-implementation",
      "test-driven-development",
      "github-collaboration",
      "git-workflow-and-versioning",
    ],
    color: "var(--ctp-green)",
  },
  {
    id: "qa",
    label: "QA Engineer",
    description: "Testing, code review, quality assurance",
    skills: [
      "code-review-and-quality",
      "debugging-and-error-recovery",
      "security-and-hardening",
    ],
    color: "var(--ctp-red)",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Code review, best practices, feedback",
    skills: [
      "code-review-and-quality",
      "code-simplification",
      "performance-optimization",
    ],
    color: "var(--ctp-yellow)",
  },
  {
    id: "devops",
    label: "DevOps",
    description: "CI/CD, infrastructure, deployment",
    skills: [
      "ci-cd-and-automation",
      "daemon-operations",
      "github-collaboration",
    ],
    color: "var(--ctp-sky)",
  },
  {
    id: "security",
    label: "Security",
    description: "Security analysis, hardening, compliance",
    skills: ["security-and-hardening", "code-review-and-quality"],
    color: "var(--ctp-peach)",
  },
];

interface RolePickerProps {
  open: boolean;
  onClose: () => void;
  currentRole: string | null;
  /**
   * Fires with the selected role id (or null for "no role"). Pre-fix this
   * was the only effect of a pick — the skills array in the hover panel
   * was decorative. Now the caller should also honour `onRoleSkills` so
   * picking a role actually activates the skills the hover panel showed.
   */
  onRoleSelect: (roleId: string | null) => void;
  /**
   * Fires alongside onRoleSelect with the role's skill list (empty array
   * when the user picks "No role"). Caller should set activeSkills to
   * this value so the chat stream carries the matching skill names and
   * the system prompt picks up the right skill contents.
   */
  onRoleSkills?: (skills: string[]) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function RolePicker({
  open,
  onClose,
  currentRole,
  onRoleSelect,
  onRoleSkills,
}: RolePickerProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose]);

  if (!open) return null;

  const hovered = ROLES.find((r) => r.id === hoveredId);

  return (
    <div
      ref={panelRef}
      data-testid="role-picker"
      className="absolute bottom-8 left-0 w-72 bg-[var(--ctp-base)] border border-[var(--ctp-surface1)] rounded-xl shadow-2xl overflow-hidden z-50"
    >
      <div className="px-3 py-2 border-b border-[var(--ctp-surface0)]">
        <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider">
          Agent Role
        </div>
      </div>

      <div className="flex">
        {/* Role list */}
        <div className="w-1/2 py-1">
          {/* Clear role option */}
          <button
            onClick={() => {
              onRoleSelect(null);
              onRoleSkills?.([]);
              onClose();
            }}
            data-testid="role-clear"
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
              currentRole === null
                ? "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
                : "text-[var(--ctp-overlay1)] hover:bg-[var(--ctp-surface0)]/50"
            }`}
          >
            No role (default)
          </button>

          {ROLES.map((role) => (
            <button
              key={role.id}
              data-testid={`role-${role.id}`}
              onClick={() => {
                onRoleSelect(role.id);
                // Activate the skills shown in the hover panel. Before this
                // change the skills array was decorative — now picking
                // "Architect" actually sets activeSkills to its three
                // skills, so chat turns carry the matching skill contents.
                onRoleSkills?.(role.skills);
                onClose();
              }}
              onMouseEnter={() => setHoveredId(role.id)}
              onMouseLeave={() => setHoveredId(null)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                currentRole === role.id
                  ? "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
                  : "text-[var(--ctp-subtext1)] hover:bg-[var(--ctp-surface0)]/50"
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: role.color }}
              />
              {role.label}
            </button>
          ))}
        </div>

        {/* Skill preview */}
        <div className="w-1/2 p-2 border-l border-[var(--ctp-surface0)]">
          {hovered ? (
            <div>
              <div
                className="text-xs font-medium mb-1"
                style={{ color: hovered.color }}
              >
                {hovered.label}
              </div>
              <div className="text-[10px] text-[var(--ctp-overlay1)] mb-2">
                {hovered.description}
              </div>
              <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider mb-1">
                Skills
              </div>
              {hovered.skills.map((skill) => (
                <div
                  key={skill}
                  className="text-[10px] text-[var(--ctp-overlay1)] truncate"
                >
                  {skill}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-[var(--ctp-overlay0)] italic">
              Hover a role to see skills
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
