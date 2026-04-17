/**
 * Toast — transient notifications with enter/exit animation.
 *
 * Provides a `useToast()` hook for any component to push a message. Pre-
 * existing error flows were either: (a) inline banners inside a view
 * (only visible when that view is mounted, which misses errors during
 * mode switches), or (b) silent catches that disappeared entirely. This
 * gives errors, warnings, and confirmations a single surface.
 *
 * Mount-once at App root via <ToastHost />. Auto-dismiss after 5s; cap
 * at 3 visible toasts so a flurry of errors doesn't cover the UI.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

export type ToastVariant = "error" | "warning" | "info" | "success";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Override the default 5s auto-dismiss. 0 = sticky until clicked. */
  durationMs?: number;
}

interface ToastContextValue {
  push: (message: string, variant?: ToastVariant, durationMs?: number) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 3;
const DEFAULT_DURATION_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (
      message: string,
      variant: ToastVariant = "info",
      durationMs: number = DEFAULT_DURATION_MS,
    ) => {
      const id = `toast-${nextId.current++}`;
      setToasts((prev) => {
        // Drop oldest if we'd exceed the cap — newest-stays-visible so the
        // user sees the most recent event, not an old queued one.
        const next = [...prev, { id, message, variant, durationMs }];
        return next.slice(-MAX_VISIBLE);
      });
      if (durationMs > 0) {
        setTimeout(() => dismiss(id), durationMs);
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ push, dismiss }}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // No provider (e.g. rendering a component in isolation for tests) —
    // return a no-op shim so callers don't have to null-check.
    return {
      push: () => {},
      dismiss: () => {},
    };
  }
  return ctx;
}

function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      data-testid="toast-host"
      className="fixed z-50 flex flex-col gap-2 pointer-events-none"
      style={{
        // Bottom-right above the status rail (32px) with some breathing room.
        right: 16,
        bottom: 48,
      }}
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

const VARIANT_COLORS: Record<ToastVariant, { bg: string; accent: string }> = {
  error: { bg: "var(--glow-red)", accent: "var(--ctp-red)" },
  warning: {
    bg: "var(--glow-yellow, rgba(249, 226, 175, 0.12))",
    accent: "var(--ctp-yellow)",
  },
  info: { bg: "var(--glow-mauve)", accent: "var(--ctp-mauve)" },
  success: { bg: "var(--glow-green)", accent: "var(--ctp-green)" },
};

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const colors = VARIANT_COLORS[toast.variant];

  // Play the fade-in on mount (via animate-slide-in-right). `leaving` is
  // set when the user clicks; we don't currently wait for an exit
  // animation because auto-dismiss is the common case and the list
  // naturally re-flows.
  const handleClick = useCallback(() => {
    setLeaving(true);
    onDismiss(toast.id);
  }, [onDismiss, toast.id]);

  return (
    <button
      onClick={handleClick}
      data-testid={`toast-${toast.variant}`}
      className="animate-slide-in-right interactive pointer-events-auto rounded-xl px-4 py-3 text-left"
      style={{
        background: colors.bg,
        border: `1px solid ${colors.accent}`,
        color: "var(--ctp-text)",
        fontSize: "var(--text-xs)",
        maxWidth: 360,
        opacity: leaving ? 0 : 1,
        transition: "opacity var(--duration-fast) var(--ease-out)",
        boxShadow: "var(--shadow-float, 0 8px 24px rgba(0, 0, 0, 0.3))",
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: colors.accent }}
        />
        <span className="flex-1">{toast.message}</span>
      </div>
    </button>
  );
}
