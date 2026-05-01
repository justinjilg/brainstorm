/**
 * Business workspace.
 *
 * Group B (this commit) split the legacy BusinessHarnessView into three
 * verb-specific bodies:
 *   - Plan    → identity header, seven folders + per-folder artifact
 *               panel, federation pointers (products / runtimes /
 *               external systems / access tiers / AI-loop budget).
 *   - Inspect → cold-open drift summary pills, AI-loop event stream,
 *               read-only customers drift detection panel.
 *   - Operate → focused open-drifts list with apply buttons + a
 *               disabled "Run indexer loop now" placeholder (wired in
 *               Group E).
 *
 * Configure remains a placeholder until the manifest editor lands.
 *
 * If no harness is open, every verb falls through to the same
 * empty-state card pointing at "Open existing" / "Create new".
 */
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
  onOpenHarness: () => void;
  /** Wired in Group C — opens the NewHarnessWizard. */
  onCreateHarness?: () => void;
}

export function BusinessWorkspace({
  verb,
  activeHarness,
  onCloseHarness,
  onOpenHarness,
  onCreateHarness,
}: BusinessWorkspaceProps) {
  if (activeHarness.kind !== "business") {
    return (
      <NoHarnessOpen
        onOpenHarness={onOpenHarness}
        onCreateHarness={onCreateHarness}
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
            sessionVerify={activeHarness.sessionVerify}
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
}: {
  onOpenHarness: () => void;
  onCreateHarness?: () => void;
}) {
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
            onClick={onOpenHarness}
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
