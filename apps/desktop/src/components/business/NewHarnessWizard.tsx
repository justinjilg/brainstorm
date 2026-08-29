/**
 * New Harness Wizard — two-screen modal that creates a fresh business
 * harness inside the desktop app. This component is purely presentational:
 * it captures form input, validates locally, and hands the confirmed
 * params to the caller via onSubmit. The caller (App.tsx) wires onSubmit
 * to the harness.init IPC route and is responsible for the actual
 * filesystem work.
 *
 * Screen 1 collects identity (name, archetype, parent path, template).
 * Screen 2 shows a read-only summary plus inline error surface for the
 * onSubmit promise. On success we fire onCreated(root) then onClose().
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";

const ARCHETYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "saas-platform", label: "saas-platform" },
  { id: "msp", label: "msp" },
];

const DEFAULT_PARENT_ROOT = "~/Businesses";

export interface NewHarnessWizardProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called when the user confirms creation. Returns a result so the wizard
   * can show success/failure inline and close the modal on success. The
   * caller (App.tsx) wires this to the harness.init IPC route.
   */
  onSubmit: (params: {
    name: string;
    archetype: string;
    parentRoot: string;
    templateSlug?: string;
  }) => Promise<{ ok: true; root: string } | { ok: false; error: string }>;
  /** Called after a successful create with the new root path. */
  onCreated: (root: string) => void;
}

/**
 * Mirrors the slug logic the harness CLI uses so the path preview the
 * user sees on screen 2 matches what actually lands on disk. Lowercase,
 * trim, strip non-alphanumerics (keeping hyphens, underscores, spaces),
 * collapse whitespace/underscores into hyphens, trim hyphen padding.
 * Falls back to "business" if the input collapses to empty.
 */
function toBusinessSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-_\s]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/^-+|-+$/g, "") || "business"
  );
}

type Step = 1 | 2;

export function NewHarnessWizard({
  open,
  onClose,
  onSubmit,
  onCreated,
}: NewHarnessWizardProps): ReactElement | null {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState<string>("");
  const [archetype, setArchetype] = useState<string>(ARCHETYPES[0]!.id);
  const [parentRoot, setParentRoot] = useState<string>(DEFAULT_PARENT_ROOT);
  const [useTemplate, setUseTemplate] = useState<boolean>(true);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Reset wizard state every time it opens so a previously-cancelled
  // attempt doesn't leak stale name / error text into the next session.
  useEffect(() => {
    if (open) {
      setStep(1);
      setName("");
      setArchetype(ARCHETYPES[0]!.id);
      setParentRoot(DEFAULT_PARENT_ROOT);
      setUseTemplate(true);
      setPending(false);
      setError(null);
    }
  }, [open]);

  // Esc closes the modal — but never while a create is in flight, since
  // the IPC call could still mutate the filesystem and we don't want the
  // user to think it failed silently.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose, pending]);

  const trimmedName = name.trim();
  const trimmedParent = parentRoot.trim();
  const nameValid = trimmedName.length >= 2;
  const parentValid = trimmedParent.length > 0;
  const canAdvance = nameValid && parentValid;

  const slugPreview = useMemo(
    () => toBusinessSlug(trimmedName.length > 0 ? trimmedName : "business"),
    [trimmedName],
  );
  const fullPath = `${trimmedParent.replace(/\/+$/, "")}/${slugPreview}`;
  const templateLabel = useTemplate ? archetype : "bare bootstrap";
  const filesNote = useTemplate
    ? "business.toml + identity stubs + .harness/ metadata + starter files"
    : "business.toml + identity stubs + .harness/ metadata";

  if (!open) return null;

  const handleNext = () => {
    if (!canAdvance) return;
    setError(null);
    setStep(2);
  };

  const handleBack = () => {
    if (pending) return;
    setError(null);
    setStep(1);
  };

  const handleCreate = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onSubmit({
        name: trimmedName,
        archetype,
        parentRoot: trimmedParent,
        ...(useTemplate ? { templateSlug: archetype } : {}),
      });
      if (result.ok) {
        onCreated(result.root);
        onClose();
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="new-harness-wizard"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[480px] max-w-[92vw] bg-[var(--ctp-base)] border border-[var(--ctp-surface1)] rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-[var(--ctp-surface0)] bg-[var(--ctp-mantle)] flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--ctp-overlay0)]">
              {step === 1 ? "Step 1 of 2 — Identity" : "Step 2 of 2 — Confirm"}
            </div>
            <div className="text-sm text-[var(--ctp-text)] font-medium mt-0.5">
              New Business Harness
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                step === 1 ? "bg-[var(--ctp-blue)]" : "bg-[var(--ctp-overlay0)]"
              }`}
            />
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                step === 2 ? "bg-[var(--ctp-blue)]" : "bg-[var(--ctp-overlay0)]"
              }`}
            />
          </div>
        </div>

        {step === 1 ? (
          <div className="px-4 py-4 space-y-3">
            <label className="block">
              <div className="text-[10px] uppercase tracking-wider text-[var(--ctp-overlay0)] mb-1">
                Name
              </div>
              <input
                type="text"
                data-testid="new-harness-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Coffee Roasters"
                autoFocus
                className="w-full px-2.5 py-1.5 text-xs text-[var(--ctp-text)] bg-[var(--ctp-surface0)] border border-[var(--ctp-surface1)] rounded-md outline-none focus:border-[var(--ctp-blue)] placeholder:text-[var(--ctp-overlay0)]"
              />
              {!nameValid && trimmedName.length > 0 && (
                <div className="text-[10px] text-[var(--ctp-red)] mt-1">
                  Name must be at least 2 characters.
                </div>
              )}
            </label>

            <label className="block">
              <div className="text-[10px] uppercase tracking-wider text-[var(--ctp-overlay0)] mb-1">
                Archetype
              </div>
              <select
                data-testid="new-harness-archetype"
                value={archetype}
                onChange={(e) => setArchetype(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs text-[var(--ctp-text)] bg-[var(--ctp-surface0)] border border-[var(--ctp-surface1)] rounded-md outline-none focus:border-[var(--ctp-blue)]"
              >
                {ARCHETYPES.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <div className="text-[10px] uppercase tracking-wider text-[var(--ctp-overlay0)] mb-1">
                Parent Folder
              </div>
              <input
                type="text"
                data-testid="new-harness-parent"
                value={parentRoot}
                onChange={(e) => setParentRoot(e.target.value)}
                placeholder={DEFAULT_PARENT_ROOT}
                className="w-full px-2.5 py-1.5 text-xs text-[var(--ctp-text)] bg-[var(--ctp-surface0)] border border-[var(--ctp-surface1)] rounded-md outline-none focus:border-[var(--ctp-blue)] placeholder:text-[var(--ctp-overlay0)] font-mono"
              />
              <div className="text-[10px] text-[var(--ctp-subtext0)] mt-1">
                The harness folder will be created inside this directory.
              </div>
            </label>

            <label className="flex items-start gap-2 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                data-testid="new-harness-use-template"
                checked={useTemplate}
                onChange={(e) => setUseTemplate(e.target.checked)}
                className="mt-0.5 accent-[var(--ctp-blue)]"
              />
              <span className="text-xs text-[var(--ctp-text)]">
                Seed from{" "}
                <span className="text-[var(--ctp-blue)] font-mono">
                  {archetype}
                </span>{" "}
                template
                <div className="text-[10px] text-[var(--ctp-subtext0)] mt-0.5">
                  Uncheck for a bare progressive bootstrap (just business.toml
                  and identity stubs).
                </div>
              </span>
            </label>
          </div>
        ) : (
          <div className="px-4 py-4 space-y-3">
            <div
              data-testid="new-harness-summary"
              className="bg-[var(--ctp-mantle)] border border-[var(--ctp-surface0)] rounded-md px-3 py-2.5 space-y-1.5"
            >
              <SummaryRow label="Name" value={trimmedName} />
              <SummaryRow label="Slug" value={slugPreview} mono />
              <SummaryRow label="Archetype" value={archetype} mono />
              <SummaryRow label="Path" value={fullPath} mono />
              <SummaryRow label="Template" value={templateLabel} mono />
            </div>

            <div className="text-[10px] text-[var(--ctp-subtext0)] leading-relaxed">
              <span className="text-[var(--ctp-overlay1)]">Will create:</span>{" "}
              {filesNote}.
            </div>

            {error && (
              <div
                data-testid="new-harness-error"
                className="text-xs text-[var(--ctp-red)] bg-[var(--ctp-red)]/10 border border-[var(--ctp-red)]/30 rounded-md px-2.5 py-1.5"
              >
                {error}
              </div>
            )}
          </div>
        )}

        <div className="px-4 py-3 border-t border-[var(--ctp-surface0)] bg-[var(--ctp-mantle)] flex items-center justify-end gap-2">
          {step === 1 ? (
            <>
              <button
                type="button"
                onClick={onClose}
                data-testid="new-harness-cancel"
                className="interactive px-3 py-1.5 text-xs rounded-md bg-[var(--ctp-surface0)] text-[var(--ctp-text)] hover:bg-[var(--ctp-surface1)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={!canAdvance}
                data-testid="new-harness-next"
                className={`interactive px-3 py-1.5 text-xs rounded-md ${
                  canAdvance
                    ? "bg-[var(--ctp-blue)] text-[var(--ctp-base)] hover:opacity-90"
                    : "bg-[var(--ctp-surface0)] text-[var(--ctp-overlay0)] cursor-not-allowed"
                }`}
              >
                Next
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleBack}
                disabled={pending}
                data-testid="new-harness-back"
                className={`interactive px-3 py-1.5 text-xs rounded-md bg-[var(--ctp-surface0)] text-[var(--ctp-text)] ${
                  pending
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-[var(--ctp-surface1)]"
                }`}
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={pending}
                data-testid="new-harness-create"
                className={`interactive px-3 py-1.5 text-xs rounded-md bg-[var(--ctp-blue)] text-[var(--ctp-base)] ${
                  pending ? "opacity-60 cursor-wait" : "hover:opacity-90"
                }`}
              >
                {pending ? "Creating…" : "Create"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface SummaryRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function SummaryRow({ label, value, mono }: SummaryRowProps): ReactElement {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-[10px] uppercase tracking-wider text-[var(--ctp-overlay0)] w-16 shrink-0">
        {label}
      </span>
      <span
        className={`text-[var(--ctp-text)] break-all ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
