// @brainst0rm/sandbox-redteam — P3.5a red-team test framework for the
// Brainstorm endpoint-agent sandbox abstraction.
//
// This package is the validation layer that — once a real sandbox boots
// (CHV on Linux per @brainst0rm/sandbox, VF on macOS per
// @brainst0rm/sandbox-vz) — proves the boundary actually contains tool
// execution. Today CHV and VF are scaffold-only; the framework runs end-
// to-end against a `MockSandbox` so probes can be developed and the
// runner / reporter can be exercised in CI.
//
// See README.md for the probe matrix, attacker-class mapping, and
// honest gap list.

export * from "./types.js";
export { RedTeamRunner } from "./runner.js";
export {
  MockSandbox,
  type MockSandboxConfig,
  type MockToolContext,
  type MockToolHandler,
} from "./mock-sandbox.js";
export { defenderToolBattery, attackerToolBattery } from "./mock-tools.js";
export {
  serializeReport,
  reportIsClean,
  summariseValidationProvenance,
  type ValidationProvenanceSummary,
} from "./reporter.js";
export { aggregate as aggregateLatency, percentile } from "./latency.js";

// Real-CHV (P3.5b) validation modes. These are intentionally separate
// from the legacy `RedTeamRunner` because the lifecycle is different:
// many sandboxes vs many probes.
export {
  runLatencyBattery,
  runConcurrentBattery,
  type SandboxFactory,
  type LatencyBatteryOptions,
  type ConcurrentBatteryOptions,
} from "./real-chv-runner.js";

export {
  buildChvConfig,
  concurrentOverrides,
  shardSocketPath,
  DEFAULT_VSOCK_SOCKET,
  DEFAULT_API_SOCKET,
  DEFAULT_GUEST_PORT,
  DEFAULT_CID,
  type ChvBuilderEnv,
  type ChvBuilderOverrides,
  type BuiltChvConfig,
} from "./chv-config-builder.js";

// Probe library
export {
  pA1NetEgress,
  pA2FsEscape,
  pA3ProcessEscape,
  pA4ResourceExhaust,
  pA5TimeBomb,
  pA6SubstrateLie,
  pA7StdoutInjection,
  pA8VsockPoison,
  makeLatencyProbe,
  makeLatencyBattery,
  ALL_ADVERSARIAL_PROBES,
  allProbes,
  HOST_SECRET_MARKER,
  type LatencyProbeOptions,
} from "./probes/index.js";
