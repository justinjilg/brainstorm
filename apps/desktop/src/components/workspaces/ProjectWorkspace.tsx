/**
 * Project workspace.
 *
 * Phase 1: Talk is the App-level ChatView; Plan and Inspect mount the
 * existing PlanView and TraceView unchanged. Operate (eval/scheduler/MCP
 * runners) and Configure (per-project settings) are placeholders for
 * Phase 2 — the slots are reserved so buried capabilities land here
 * naturally.
 */
import { Placeholder } from "./Placeholder";
import { PlanView } from "../plan/PlanView";
import { TraceView, type TraceEvent } from "../trace/TraceView";
import { ErrorBoundary } from "../ErrorBoundary";
import type { VerbKind } from "../../lib/workspace";

interface ProjectWorkspaceProps {
  verb: VerbKind;
  traceEvents: TraceEvent[];
  onTraceEventSelect: (event: TraceEvent) => void;
}

export function ProjectWorkspace({
  verb,
  traceEvents,
  onTraceEventSelect,
}: ProjectWorkspaceProps) {
  switch (verb) {
    case "talk":
      return null; // App-level ChatView
    case "plan":
      return (
        <ErrorBoundary fallbackLabel="Plan">
          <PlanView />
        </ErrorBoundary>
      );
    case "inspect":
      return (
        <ErrorBoundary fallbackLabel="Trace">
          <TraceView events={traceEvents} onEventSelect={onTraceEventSelect} />
        </ErrorBoundary>
      );
    case "operate":
      return (
        <Placeholder
          title="Eval · Scheduler · MCP"
          description="Run the eval suite (7 capability dimensions), trigger scheduled work, call MCP tools — all scoped to this project. Wraps packages/eval, packages/scheduler, packages/mcp."
        />
      );
    case "configure":
      return (
        <Placeholder
          title="Per-project settings"
          description="Project-local router strategy, .brainstorm/config overrides, sector partitioning for code-graph."
        />
      );
    default:
      return null;
  }
}
