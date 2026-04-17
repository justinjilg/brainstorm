/**
 * RollingCost — per-digit-flash cost display.
 *
 * The StatusRail previously jumped instantly from $0.0123 to $0.0124 with
 * no visual signal that the number changed. For a metered app where the
 * cost is the main thing the user watches during a turn, a snapping digit
 * reads as "nothing is happening." This component splits the formatted
 * value into per-character spans and flashes each changed digit briefly
 * on update, so the eye catches every tick.
 *
 * Deliberately modest: the flash is a short color pulse, not a slot-machine
 * roll. Slot-machine animations look cute but add 300ms+ per change, which
 * compounds visually when the cost updates every streamed chunk.
 */

import { useEffect, useRef, useState } from "react";

export function RollingCost({
  cost,
  color,
  testId,
}: {
  cost: number;
  color: string;
  testId?: string;
}) {
  const formatted = `$${cost.toFixed(4)}`;
  const previousRef = useRef<string>(formatted);
  const [flashKeys, setFlashKeys] = useState<number[]>([]);

  useEffect(() => {
    const prev = previousRef.current;
    const next = formatted;
    if (prev === next) return;

    // Diff character positions — only the digits that actually changed get
    // the flash, so a leading "$0." doesn't re-animate on every tick.
    const changed: number[] = [];
    const maxLen = Math.max(prev.length, next.length);
    for (let i = 0; i < maxLen; i++) {
      if (prev[i] !== next[i]) changed.push(i);
    }
    setFlashKeys(changed);
    previousRef.current = next;

    // Clear the flash marker after the animation completes so the next
    // update can re-trigger for the same indices.
    const t = setTimeout(() => setFlashKeys([]), 360);
    return () => clearTimeout(t);
  }, [formatted]);

  const chars = formatted.split("");

  return (
    <span
      className="font-mono px-2 inline-flex"
      data-testid={testId}
      style={{ color }}
      title={`Session cost: ${formatted}`}
    >
      {chars.map((c, i) => {
        const isFlashing = flashKeys.includes(i);
        return (
          <span
            key={`${i}-${c}-${isFlashing ? "flash" : "idle"}`}
            style={{
              display: "inline-block",
              // Reserve a stable width for digit columns so the total label
              // doesn't shift when the cost crosses a decimal boundary.
              minWidth: /[0-9]/.test(c) ? "0.55em" : undefined,
              animation: isFlashing
                ? "cost-digit-flash 340ms var(--ease-out)"
                : undefined,
            }}
          >
            {c}
          </span>
        );
      })}
    </span>
  );
}
