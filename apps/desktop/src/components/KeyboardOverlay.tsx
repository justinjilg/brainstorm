/**
 * Keyboard Shortcut Overlay — Cmd+? shows the shortcuts wired in
 * App.tsx's handleKeyDown. Every entry here must reflect a real
 * binding; stubs for approvals / KAIROS toggle / slash commands /
 * mentions etc. were removed because they over-promised what ships.
 *
 * When new shortcuts land, update here AND the handler together.
 */

interface KeyboardOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardOverlay({ open, onClose }: KeyboardOverlayProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-testid="keyboard-overlay"
      onClick={onClose}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-float"
        data-testid="keyboard-backdrop"
      />
      <div
        className="relative w-[560px] max-h-[500px] rounded-2xl overflow-y-auto animate-fade-in"
        style={{
          background: "var(--surface-float)",
          boxShadow: "var(--shadow-float)",
          border: "1px solid var(--border-default)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--ctp-surface0)]">
          <div className="text-sm font-medium text-[var(--ctp-text)]">
            Keyboard Shortcuts
          </div>
          <div className="text-[10px] text-[var(--ctp-overlay0)] mt-0.5">
            Click anywhere outside to dismiss
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-0 p-6">
          <ShortcutGroup title="Modes">
            <Shortcut keys="⌘1" label="Chat" />
            <Shortcut keys="⌘2" label="Dashboard" />
            <Shortcut keys="⌘3" label="Models" />
            <Shortcut keys="⌘4" label="Memory" />
            <Shortcut keys="⌘5" label="Skills" />
            <Shortcut keys="⌘6" label="Workflows" />
            <Shortcut keys="⌘7" label="Security" />
            <Shortcut keys="⌘8" label="Config" />
          </ShortcutGroup>

          <ShortcutGroup title="Panels">
            <Shortcut keys="⌘B" label="Toggle sidebar" />
            <Shortcut keys="⌘D" label="Toggle detail panel" />
            <Shortcut keys="⌘K" label="Command palette" />
            <Shortcut keys="⌘?" label="This overlay" />
          </ShortcutGroup>

          <ShortcutGroup title="Chat">
            <Shortcut keys="Enter" label="Send message" />
            <Shortcut keys="⇧Enter" label="New line" />
            <Shortcut keys="Esc" label="Abort streaming response" />
          </ShortcutGroup>

          <ShortcutGroup title="General">
            <Shortcut keys="⌘Q" label="Quit Brainstorm" />
            <Shortcut keys="⌘W" label="Close window" />
          </ShortcutGroup>
        </div>
      </div>
    </div>
  );
}

function ShortcutGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider mb-1.5">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs text-[var(--ctp-subtext1)]">{label}</span>
      <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] border border-[var(--ctp-surface1)]">
        {keys}
      </kbd>
    </div>
  );
}
