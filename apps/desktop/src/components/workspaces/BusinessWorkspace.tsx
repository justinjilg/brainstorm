/**
 * Business workspace.
 *
 * Phase 1: Plan mounts the existing BusinessHarnessView (manifest + 7
 * folders + drift panel + loop log) — Group B will split this across
 * Plan/Inspect/Operate. For now the whole thing renders under Plan and
 * Inspect/Operate/Configure show placeholders that name what's coming.
 *
 * If no harness is open (`activeHarness.kind !== 'business'`), every
 * verb shows the same empty-state card pointing at "Open existing" and
 * "Create new" actions. The latter wires up in Group C (NewHarnessWizard).
 */
import { Placeholder } from "./Placeholder";
import { BusinessHarnessView } from "../harness/BusinessHarnessView";
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
        <ErrorBoundary fallbackLabel="Business Harness">
          <BusinessHarnessView
            root={activeHarness.root}
            manifest={activeHarness.manifest}
            sessionVerify={activeHarness.sessionVerify}
            onClose={onCloseHarness}
          />
        </ErrorBoundary>
      );
    case "inspect":
      return (
        <Placeholder
          title="Drift · Index · AI Loops"
          description="The drift detector results, index coherence, and harness-loop event stream split out from the Plan view. Group B move."
        />
      );
    case "operate":
      return (
        <Placeholder
          title="Init · Apply · Encrypt"
          description="Create a new harness (Group C wizard), apply intent→runtime ChangeSets, encrypt artifacts via age + sops, rotate keys. Wraps harness-fs init + harness-crypto."
        />
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
