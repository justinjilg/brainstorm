// Probe library — all built-in probes for the P3.5a red-team battery.
//
// Most probes target a "should-fail" expectation (the attack must be
// contained). The "all" battery is the default for CLI / CI; integrators
// can compose smaller batteries from the named exports.

export { pA1NetEgress } from "./p-a1-net-egress.js";
export { pA2FsEscape, HOST_SECRET_MARKER } from "./p-a2-fs-escape.js";
export { pA3ProcessEscape } from "./p-a3-process-escape.js";
export { pA4ResourceExhaust } from "./p-a4-resource-exhaust.js";
export { pA5TimeBomb } from "./p-a5-time-bomb.js";
export { pA6SubstrateLie } from "./p-a6-substrate-lie.js";
export { pA7StdoutInjection } from "./p-a7-stdout-injection.js";
export { pA8VsockPoison } from "./p-a8-vsock-poison.js";
export {
  makeLatencyProbe,
  makeLatencyBattery,
  type LatencyProbeOptions,
} from "./p-lat.js";

import { pA1NetEgress } from "./p-a1-net-egress.js";
import { pA2FsEscape } from "./p-a2-fs-escape.js";
import { pA3ProcessEscape } from "./p-a3-process-escape.js";
import { pA4ResourceExhaust } from "./p-a4-resource-exhaust.js";
import { pA5TimeBomb } from "./p-a5-time-bomb.js";
import { pA6SubstrateLie } from "./p-a6-substrate-lie.js";
import { pA7StdoutInjection } from "./p-a7-stdout-injection.js";
import { pA8VsockPoison } from "./p-a8-vsock-poison.js";
import { makeLatencyBattery, type LatencyProbeOptions } from "./p-lat.js";
import type { Probe } from "../types.js";

/**
 * All adversarial (A1-A8) probes, no latency battery.
 *
 * Ordering note: P-A6 is intentionally LAST. P-A6 drives the sandbox to a
 * detected-divergence ("failed") state by design, which the runner
 * honours by skipping subsequent probes. Putting P-A6 last lets the
 * other 7 probes complete cleanly first.
 */
export const ALL_ADVERSARIAL_PROBES: Probe[] = [
  pA1NetEgress,
  pA2FsEscape,
  pA3ProcessEscape,
  pA4ResourceExhaust,
  pA5TimeBomb,
  pA7StdoutInjection,
  pA8VsockPoison,
  pA6SubstrateLie,
];

/** Full battery: adversarial + latency. */
export function allProbes(latencyOpts?: LatencyProbeOptions): Probe[] {
  return [...ALL_ADVERSARIAL_PROBES, ...makeLatencyBattery(latencyOpts)];
}
