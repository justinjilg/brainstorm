/**
 * Keyboard Shortcut Overlay — Cmd+? shows all available shortcuts.
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
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/60" />
      <div
        className="relative w-[600px] max-h-[500px] bg-[var(--ctp-base)] border border-[var(--ctp-surface1)] rounded-xl shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--ctp-surface0)]">
          <div className="text-sm font-medium text-[var(--ctp-text)]">
            Keyboard Shortcuts
          </div>
          <div className="text-[10px] text-[var(--ctp-overlay0)] mt-0.5">
            Press any key to dismiss
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-0 p-6">
          <ShortcutGroup title="Navigation">
            <Shortcut keys="⌘1-8" label="Switch modes" />
            <Shortcut keys="⌘K" label="Command palette" />
            <Shortcut keys="⌘B" label="Toggle sidebar" />
            <Shortcut keys="⌘D" label="Toggle detail panel" />
            <Shortcut keys="⌘N" label="New conversation" />
            <Shortcut keys="Esc" label="Return to chat / abort" />
          </ShortcutGroup>

          <ShortcutGroup title="Chat">
            <Shortcut keys="Enter" label="Send message" />
            <Shortcut keys="⇧Enter" label="New line" />
            <Shortcut keys="Esc" label="Abort processing" />
            <Shortcut keys="/" label="Slash commands" />
            <Shortcut keys="@" label="Mentions" />
          </ShortcutGroup>

          <ShortcutGroup title="Approvals">
            <Shortcut keys="⌘Enter" label="Allow" />
            <Shortcut keys="⌘⌫" label="Deny" />
            <Shortcut keys="⌘⇧Enter" label="Always allow" />
            <Shortcut keys="⌘⇧Tab" label="Cycle permission mode" />
          </ShortcutGroup>

          <ShortcutGroup title="KAIROS">
            <Shortcut keys="⌘/" label="Toggle daemon" />
            <Shortcut keys="⌘L" label="View daily log" />
          </ShortcutGroup>

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

          <ShortcutGroup title="General">
            <Shortcut keys="⌘?" label="This overlay" />
            <Shortcut keys="⌘." label="Abort agent" />
            <Shortcut keys="⌘Q" label="Quit" />
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
