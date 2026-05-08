/**
 * Placeholder body for verbs that don't have a real implementation yet.
 * Used in Phase 1 to give every verb tab a consistent landing while
 * Phase 2 fills in the buried-capability views (eval runner, scheduler,
 * code-graph, vault editor, etc.).
 *
 * The text should describe what's coming, not "TODO". The user reads
 * these to understand where features will land.
 */

export function Placeholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        background: "var(--ctp-base)",
        color: "var(--ctp-text)",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          textAlign: "center",
          padding: 32,
          background: "var(--ctp-mantle)",
          border: "1px dashed var(--border-subtle)",
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
          Coming in Phase 2
        </div>
        <div
          style={{
            fontSize: "var(--text-lg, 18px)",
            fontWeight: 600,
            color: "var(--ctp-text)",
            marginBottom: 12,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ctp-subtext1)",
            lineHeight: 1.6,
          }}
        >
          {description}
        </div>
      </div>
    </div>
  );
}
