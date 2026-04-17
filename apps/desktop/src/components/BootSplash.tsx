/**
 * BootSplash — renders while the backend child process is starting up.
 *
 * Before this existed, App.tsx rendered the full 10-view shell the moment
 * React mounted, even though the brainstorm ipc child process wasn't
 * ready yet. Every data hook fired its mount-time IPC call, hit a 30s
 * timeout, and surfaced "Failed to load X" banners for the first second
 * or two of app life. Reads like a broken app.
 *
 * The splash sits over the shell until the first `backend-ready` signal.
 * Kept deliberately minimal — no spinner stock-art, just the mark + a
 * typographic "Starting Brainstorm…" line and the Catppuccin Mocha
 * palette. The animate-pulse-glow pulls its own weight as the "alive"
 * signal.
 */

export function BootSplash() {
  return (
    <div
      data-testid="boot-splash"
      className="flex flex-col items-center justify-center h-screen w-screen select-none"
      style={{ background: "var(--ctp-crust)" }}
    >
      <div
        className="animate-pulse-glow"
        style={{
          fontSize: "var(--text-3xl, 1.75rem)",
          fontWeight: 600,
          color: "var(--ctp-mauve)",
          letterSpacing: "-0.01em",
        }}
      >
        Brainstorm
      </div>
      <div
        className="mt-3 font-mono"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Starting backend…
      </div>
    </div>
  );
}
