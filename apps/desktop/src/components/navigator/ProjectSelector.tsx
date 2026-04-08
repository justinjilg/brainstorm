/**
 * Project Selector — folder picker with recent projects.
 * Like Cowork's project selection UI.
 */

import { useState } from "react";

interface Project {
  path: string;
  name: string;
  lastOpened: string;
}

interface ProjectSelectorProps {
  currentProject: string | null;
  recentProjects: Project[];
  onProjectSelect: (path: string) => void;
  onOpenFolder: () => void;
}

export function ProjectSelector({
  currentProject,
  recentProjects,
  onProjectSelect,
  onOpenFolder,
}: ProjectSelectorProps) {
  const [expanded, setExpanded] = useState(false);

  const currentName = currentProject
    ? (currentProject.split("/").pop() ?? currentProject)
    : "No project";

  return (
    <div className="px-3 pt-3 pb-2">
      {/* Current project button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="interactive w-full flex items-center gap-2 px-3 py-2 rounded-xl"
        style={{
          background: "var(--ctp-surface0)",
          border: "1px solid var(--border-default)",
        }}
      >
        <span
          style={{ fontSize: "var(--text-sm)", color: "var(--ctp-overlay1)" }}
        >
          📁
        </span>
        <div className="flex-1 text-left min-w-0">
          <div
            className="truncate font-medium"
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
          >
            {currentName}
          </div>
          {currentProject && (
            <div
              className="truncate"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              {currentProject}
            </div>
          )}
        </div>
        <span
          className="shrink-0"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            transform: expanded ? "rotate(180deg)" : "rotate(0)",
            transition: "transform var(--duration-fast) var(--ease-out)",
          }}
        >
          ▾
        </span>
      </button>

      {/* Dropdown */}
      {expanded && (
        <div
          className="mt-1 rounded-xl overflow-hidden animate-fade-in"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-default)",
          }}
        >
          {/* Recent projects */}
          {recentProjects.length > 0 && (
            <div>
              <div
                className="px-3 py-1.5"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                Recent
              </div>
              {recentProjects.map((project) => (
                <button
                  key={project.path}
                  onClick={() => {
                    onProjectSelect(project.path);
                    setExpanded(false);
                  }}
                  className="interactive w-full text-left px-3 py-2 flex items-center gap-2"
                  style={{
                    borderBottom: "1px solid var(--border-subtle)",
                    background:
                      currentProject === project.path
                        ? "var(--surface-elevated)"
                        : "transparent",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ctp-overlay1)",
                    }}
                  >
                    📁
                  </span>
                  <div className="flex-1 min-w-0">
                    <div
                      className="truncate"
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ctp-text)",
                      }}
                    >
                      {project.name}
                    </div>
                    <div
                      className="truncate"
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ctp-overlay0)",
                      }}
                    >
                      {project.path}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Open folder */}
          <button
            onClick={() => {
              onOpenFolder();
              setExpanded(false);
            }}
            className="interactive w-full text-left px-3 py-2.5 flex items-center gap-2"
          >
            <span
              style={{ fontSize: "var(--text-xs)", color: "var(--ctp-mauve)" }}
            >
              +
            </span>
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-subtext1)",
              }}
            >
              Open Project Folder
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
