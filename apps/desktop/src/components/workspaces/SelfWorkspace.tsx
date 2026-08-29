/**
 * Self workspace.
 *
 * Phase 1: Plan is a Welcome / first-run card with three buttons (open
 * project, open harness, create harness). Inspect mounts MemoryView,
 * Operate mounts SkillsView. Configure is a placeholder for preferences /
 * keybindings / palette config.
 */
import { Placeholder } from "./Placeholder";
import { MemoryView } from "../memory/MemoryView";
import { SkillsView } from "../skills/SkillsView";
import { ErrorBoundary } from "../ErrorBoundary";
import { KairosLivePanel } from "../KairosLivePanel";
import type { VerbKind } from "../../lib/workspace";

interface SelfWorkspaceProps {
  verb: VerbKind;
  activeSkills: string[];
  onActiveSkillsChange: (skills: string[]) => void;
  onOpenFolder: () => void;
  onOpenHarness: () => void;
  onCreateHarness?: () => void;
}

export function SelfWorkspace({
  verb,
  activeSkills,
  onActiveSkillsChange,
  onOpenFolder,
  onOpenHarness,
  onCreateHarness,
}: SelfWorkspaceProps) {
  switch (verb) {
    case "plan":
      return (
        <WelcomeCard
          onOpenFolder={onOpenFolder}
          onOpenHarness={onOpenHarness}
          onCreateHarness={onCreateHarness}
        />
      );
    case "inspect":
      return (
        <ErrorBoundary fallbackLabel="Memory">
          <MemoryView />
        </ErrorBoundary>
      );
    case "operate":
      return (
        <ErrorBoundary fallbackLabel="Skills">
          <SkillsView
            activeSkills={activeSkills}
            onActiveSkillsChange={onActiveSkillsChange}
          />
        </ErrorBoundary>
      );
    case "configure":
      return (
        <Placeholder
          title="Preferences · Keybindings · Palette"
          description="User-level theme, keyboard shortcuts, and command-palette filters. Palette config is the most useful slot — Phase 2 makes it user-editable."
        />
      );
    default:
      return null;
  }
}

function WelcomeCard({
  onOpenFolder,
  onOpenHarness,
  onCreateHarness,
}: {
  onOpenFolder: () => void;
  onOpenHarness: () => void;
  onCreateHarness?: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: 40,
        overflowY: "auto",
        background: "var(--ctp-base)",
      }}
    >
      {/* The living heartbeat — KAIROS self-improvement, visible. */}
      <KairosLivePanel />
      <div
        style={{
          maxWidth: 540,
          padding: 36,
          background: "var(--ctp-mantle)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 14,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-2xs)",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: "var(--ctp-overlay0)",
            marginBottom: 10,
          }}
        >
          Brainstorm Desktop
        </div>
        <h1
          style={{
            fontSize: "var(--text-2xl, 22px)",
            fontWeight: 600,
            color: "var(--ctp-text)",
            margin: "0 0 12px",
          }}
        >
          Pick what you're working on
        </h1>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ctp-subtext1)",
            lineHeight: 1.6,
            marginBottom: 28,
          }}
        >
          A <strong>project</strong> is any code repo. A{" "}
          <strong>business harness</strong> is a git-versioned business-as-code
          tree (identity, team, customers, products, operations, market,
          governance). Both can live side-by-side.
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <ActionButton onClick={onOpenFolder} label="Open project" />
          <ActionButton onClick={onOpenHarness} label="Open business harness" />
          {onCreateHarness && (
            <ActionButton
              onClick={onCreateHarness}
              label="Create new harness"
              primary
            />
          )}
        </div>
        {!onCreateHarness && (
          <div
            style={{
              marginTop: 18,
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            (Create-new wizard ships in Group C. For now:{" "}
            <code>
              brainstorm harness init &lt;name&gt; --template saas-platform
            </code>
            )
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  label,
  primary,
}: {
  onClick: () => void;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="interactive"
      style={{
        padding: "10px 18px",
        fontSize: "var(--text-sm)",
        fontWeight: primary ? 600 : 500,
        color: primary ? "var(--ctp-base)" : "var(--ctp-text)",
        background: primary ? "var(--ctp-blue)" : "var(--ctp-surface0)",
        border: `1px solid ${primary ? "var(--ctp-blue)" : "var(--border-subtle)"}`,
        borderRadius: 8,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
