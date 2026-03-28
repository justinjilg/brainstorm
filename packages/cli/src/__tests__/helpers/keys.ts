/**
 * ANSI escape sequences for simulating keystrokes in ink-testing-library.
 *
 * Usage: stdin.write(KEYS.UP) to simulate pressing the up arrow.
 */

export const KEYS = {
  UP: "\u001B[A",
  DOWN: "\u001B[B",
  RIGHT: "\u001B[C",
  LEFT: "\u001B[D",
  ENTER: "\r",
  ESCAPE: "\u001B",
  TAB: "\t",
  SHIFT_TAB: "\u001B[Z",
  BACKSPACE: "\u007F",
  DELETE: "\u001B[3~",
  SPACE: " ",
  CTRL_C: "\u0003",
  CTRL_D: "\u0004",
  CTRL_K: "\u000B",
  CTRL_L: "\u000C",
} as const;

/**
 * Type a string character by character into stdin.
 */
export function typeText(
  stdin: { write: (data: string) => void },
  text: string,
): void {
  for (const char of text) {
    stdin.write(char);
  }
}

/**
 * Wait for Ink to process state updates and re-render.
 *
 * Ink uses React's batched updates via reconciler.batchedUpdates(),
 * then React schedules a synchronous re-render. We need to flush
 * both microtasks and macrotasks to ensure the output frame is updated.
 */
export async function waitForRender(): Promise<void> {
  // Flush microtasks (Promise callbacks, React scheduler)
  await new Promise((r) => setImmediate(r));
  // Flush macrotasks (setTimeout callbacks from React reconciler)
  await new Promise((r) => setTimeout(r, 0));
  // One more microtask flush for good measure
  await new Promise((r) => setImmediate(r));
}

/**
 * Press a key and wait for Ink to re-render.
 */
export async function press(
  stdin: { write: (data: string) => void },
  key: string,
): Promise<void> {
  // Ensure Ink has mounted and set up the readable listener first
  await waitForRender();
  stdin.write(key);
  await waitForRender();
}
