/**
 * Shared timeout controller utility.
 * Creates an AbortSignal that fires after the given milliseconds,
 * plus a cleanup function to cancel the timer if the operation completes early.
 */
export function createTimeoutController(ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref(); // Don't keep event loop alive

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}
