import { useEffect, useRef } from "react";
import { useToast, type ToastVariant } from "../components/Toast";

/**
 * Surface a hook's `error` state as a transient toast.
 *
 * Call once per hook that exposes an `error: string | null`. When the
 * error flips from null to a string, we push a toast. The same error
 * staying set across re-renders does not re-fire — a `lastError` ref
 * dedupes — so a persistent failure shows once, not every render.
 *
 * Consumers:
 *   useErrorToast(conversationsError, "Conversations");
 *   useErrorToast(kairosError, "KAIROS");
 *   useErrorToast(memoryError, "Memory");
 *
 * The prefix is just a hint of what produced the error; it lands in
 * the toast as "<prefix>: <message>" for attribution.
 */
export function useErrorToast(
  error: string | null | undefined,
  prefix?: string,
  variant: ToastVariant = "error",
): void {
  const toast = useToast();
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    const current = error ?? null;
    if (current && current !== lastError.current) {
      toast.push(prefix ? `${prefix}: ${current}` : current, variant);
    }
    lastError.current = current;
  }, [error, prefix, variant, toast]);
}
