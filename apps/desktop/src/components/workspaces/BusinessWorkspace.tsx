/**
 * Business workspace. Routes to a verb-specific body when a harness is
 * open; otherwise renders an empty-state card with Open/Create actions.
 * Plan / Inspect / Operate / Configure each render in their own body
 * file under ../business/.
 */
import { useEffect, useState } from "react";
import { Placeholder } from "./Placeholder";
import { BusinessPlanBody } from "../business/BusinessPlanBody";
import { BusinessInspectBody } from "../business/BusinessInspectBody";
import { BusinessOperateBody } from "../business/BusinessOperateBody";
import { ErrorBoundary } from "../ErrorBoundary";
import type { ActiveHarness } from "../../lib/harness-types";
import type { VerbKind } from "../../lib/workspace";

interface BusinessWorkspaceProps {
  verb: VerbKind;
  activeHarness: ActiveHarness;
  onCloseHarness: () => void;
  onOpenHarness: (root?: string) => void;
  /** Wired in Group C — opens the NewHarnessWizard. */
  onCreateHarness?: () => void;
  /** Project path currently open (if any) — used to detect ancestor harness. */
  currentProject?: string | null;
}

export function BusinessWorkspace({
  verb,
  activeHarness,
  onCloseHarness,
  onOpenHarness,
  onCreateHarness,
  currentProject,
}: BusinessWorkspaceProps) {
  if (activeHarness.kind !== "business") {
    return (
      <NoHarnessOpen
        onOpenHarness={onOpenHarness}
        onCreateHarness={onCreateHarness}
        currentProject={currentProject ?? null}
      />
    );
  }

  switch (verb) {
    case "talk":
      return null; // App-level ChatView
    case "plan":
      return (
        <ErrorBoundary fallbackLabel="Business Plan">
          <BusinessPlanBody
            root={activeHarness.root}
            manifest={activeHarness.manifest}
            sessionVerify={activeHarness.sessionVerify}
            onClose={onCloseHarness}
          />
        </ErrorBoundary>
      );
    case "inspect":
      return (
        <ErrorBoundary fallbackLabel="Business Inspect">
          <BusinessInspectBody
            root={activeHarness.root}
            manifest={activeHarness.manifest}
            sessionVerify={activeHarness.sessionVerify}
          />
        </ErrorBoundary>
      );
    case "operate":
      return (
        <ErrorBoundary fallbackLabel="Business Operate">
          <BusinessOperateBody
            root={activeHarness.root}
            manifest={activeHarness.manifest}
          />
        </ErrorBoundary>
      );
    case "configure":
      return (
        <Placeholder
          title="Manifest · Access · Budget"
          description="Edit business.toml directly, tune access tiers (sensitive/confidential/restricted), set the AI-loop monthly budget and per-run cap."
        />
      );
    default:
      return null;
  }
}

function NoHarnessOpen({
  onOpenHarness,
  onCreateHarness,
  currentProject,
}: {
  onOpenHarness: (root?: string) => void;
  onCreateHarness?: () => void;
  currentProject: string | null;
}) {
  const [detectedHarnessRoot, setDetectedHarnessRoot] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;
    if (!currentProject) {
      setDetectedHarnessRoot(null);
      return;
    }
    const bridge = window.brainstorm;
    if (!bridge?.detectHarness) return;
    bridge
      .detectHarness(currentProject)
      .then((result) => {
        if (!mounted) return;
        if (result.kind === "business") {
          setDetectedHarnessRoot(result.root);
        } else {
          setDetectedHarnessRoot(null);
        }
      })
      .catch(() => {
        if (mounted) setDetectedHarnessRoot(null);
      });
    return () => {
      mounted = false;
    };
  }, [currentProject]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        background: "var(--ctp-base)",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          textAlign: "center",
          padding: 32,
          background: "var(--ctp-mantle)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 12,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-2xs)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--ctp-overlay0)",
            marginBottom: 8,
          }}
        >
          Business Harness
        </div>
        <div
          style={{
            fontSize: "var(--text-lg, 18px)",
            fontWeight: 600,
            color: "var(--ctp-text)",
            marginBottom: 12,
          }}
        >
          No harness open
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ctp-subtext1)",
            lineHeight: 1.6,
            marginBottom: 20,
          }}
        >
          A business harness is a git-versioned tree describing your identity,
          team, customers, products, operations, market, and governance —
          federated over code, runtimes, and external systems.
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={() => onOpenHarness()}
            className="interactive"
            style={{
              padding: "10px 18px",
              fontSize: "var(--text-sm)",
              fontWeight: 500,
              color: "var(--ctp-text)",
              background: "var(--ctp-surface0)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Open existing harness
          </button>
          {onCreateHarness && (
            <button
              onClick={onCreateHarness}
              className="interactive"
              style={{
                padding: "10px 18px",
                fontSize: "var(--text-sm)",
                fontWeight: 600,
                color: "var(--ctp-base)",
                background: "var(--ctp-blue)",
                border: "1px solid var(--ctp-blue)",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Create new harness
            </button>
          )}
        </div>
        {detectedHarnessRoot && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "var(--ctp-surface0)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 8,
              fontSize: "var(--text-xs)",
              color: "var(--ctp-subtext1)",
              textAlign: "left",
            }}
          >
            <div style={{ marginBottom: 8 }}>
              Detected a business harness at an ancestor of the current project.
            </div>
            <button
              onClick={() => onOpenHarness(detectedHarnessRoot)}
              className="interactive"
              style={{
                padding: "8px 14px",
                fontSize: "var(--text-xs)",
                fontWeight: 500,
                color: "var(--ctp-text)",
                background: "var(--ctp-surface1)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              Open detected harness at {detectedHarnessRoot}
            </button>
          </div>
        )}
        {!onCreateHarness && (
          <div
            style={{
              marginTop: 16,
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            (Create-new wizard ships in Group C — for now use{" "}
            <code>brainstorm harness init</code> from the CLI.)
          </div>
        )}
      </div>
    </div>
  );
}
