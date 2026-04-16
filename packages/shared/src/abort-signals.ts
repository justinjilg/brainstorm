/**
 * Register `fn` as an abort handler on `signal`. Returns an `off()` that
 * removes the listener. If the signal is already aborted, `fn` is queued
 * as a microtask and `off()` is a no-op.
 */
export function onAbort(signal: AbortSignal, fn: () => void): () => void {
  if (signal.aborted) {
    queueMicrotask(fn);
    return () => {};
  }
  const listener = () => fn();
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

/**
 * Return a single AbortSignal that aborts when any of the input signals
 * aborts. `undefined` inputs are ignored so callers can safely spread
 * optional signals without branching.
 *
 * When the returned signal fires, all listeners attached to the input
 * signals are detached to avoid leaking references into long-lived
 * parent controllers.
 */
export function linkSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => s !== undefined);
  const controller = new AbortController();

  // Fast path: already-aborted input.
  const alreadyAborted = filtered.find((s) => s.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }

  const offs: Array<() => void> = [];
  for (const input of filtered) {
    offs.push(
      onAbort(input, () => {
        if (controller.signal.aborted) return;
        controller.abort(input.reason);
        for (const off of offs) off();
      }),
    );
  }

  return controller.signal;
}
