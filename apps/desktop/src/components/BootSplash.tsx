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
      {/* Mark — rendered inline so we can animate its spark node. The
          same asset is committed at /public/brainstorm.svg for the
          favicon. Spark node breathes at 2s via animate-pulse-glow so
          the splash reads as alive, not frozen. */}
      <svg
        viewBox="0 0 64 64"
        width={96}
        height={96}
        fill="none"
        aria-label="Brainstorm"
      >
        <circle cx="32" cy="20" r="9" fill="#cba6f7" fillOpacity="0.12" />
        <circle cx="32" cy="20" r="6.5" fill="#cba6f7" fillOpacity="0.18" />
        <path
          d="M32 20 L20 40 L32 50 L44 40 Z"
          stroke="#cba6f7"
          strokeWidth="1.25"
          strokeOpacity="0.55"
          strokeLinejoin="round"
        />
        <line
          x1="20"
          y1="40"
          x2="44"
          y2="40"
          stroke="#bac2de"
          strokeWidth="1"
          strokeOpacity="0.3"
        />
        <circle
          cx="20"
          cy="40"
          r="2.75"
          fill="#181825"
          stroke="#bac2de"
          strokeWidth="1.25"
        />
        <circle
          cx="44"
          cy="40"
          r="2.75"
          fill="#181825"
          stroke="#bac2de"
          strokeWidth="1.25"
        />
        <circle
          cx="32"
          cy="50"
          r="2.75"
          fill="#181825"
          stroke="#bac2de"
          strokeWidth="1.25"
        />
        <circle
          cx="32"
          cy="20"
          r="3.75"
          fill="#cba6f7"
          className="animate-pulse-glow"
        />
      </svg>

      <div
        className="mt-6"
        style={{
          fontSize: "var(--text-xl, 1.25rem)",
          fontWeight: 600,
          color: "var(--ctp-text)",
          letterSpacing: "-0.01em",
        }}
      >
        Brainstorm
      </div>
      <div
        className="mt-2 font-mono"
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
