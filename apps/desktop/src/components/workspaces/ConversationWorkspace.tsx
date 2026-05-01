/**
 * Conversation workspace.
 *
 * Phase 1: Talk is handled by the always-mounted ChatView at the App level
 * (so message history is preserved when switching workspaces). The other
 * verbs are placeholders — Phase 2 will surface thread metadata, fork /
 * archive controls, and per-thread model/role overrides.
 */
import { Placeholder } from "./Placeholder";
import type { VerbKind } from "../../lib/workspace";

export function ConversationWorkspace({ verb }: { verb: VerbKind }) {
  switch (verb) {
    case "talk":
      // Rendered at the App level so chat history persists across entity
      // switches. Returning null here lets the App-level mount show through.
      return null;
    case "inspect":
      return (
        <Placeholder
          title="Conversation metadata"
          description="Per-thread token counts, cost breakdown, and tool-call summary will land here. Wraps the existing InspectorPanel."
        />
      );
    case "operate":
      return (
        <Placeholder
          title="Resume · Fork · Archive"
          description="Thread-level actions: resume from a checkpoint, fork into a new thread, archive when done. Backed by the existing conversations API."
        />
      );
    case "configure":
      return (
        <Placeholder
          title="Per-thread settings"
          description="Override the active model, role, and skills just for this thread. Today these are global; Phase 2 makes them per-conversation."
        />
      );
    default:
      return null;
  }
}
