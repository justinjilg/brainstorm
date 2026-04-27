# @brainst0rm/sandbox-redteam

P3.5a red-team test framework for the Brainstorm endpoint-agent sandbox boundary.

## Status

This package is the **validation layer**. It runs a configurable battery of probes (mapped to the A1–A10 attacker classes from the threat model) against any concrete `Sandbox` implementation. Once CHV (`@brainst0rm/sandbox`) and VF (`@brainst0rm/sandbox-vz`) first-boot, this is what proves the boundary actually contains tool execution.

Today, both real backends are **scaffold-only** (PR #277). All probes are validated against a `MockSandbox` that mirrors the `Sandbox` interface. The `validatedAgainst` field on each probe declares this honestly.

## Architecture

```
RedTeamRunner
    │
    ├─ sandbox.boot()        (autoBoot, opt-out)
    │
    └─ for each Probe:
         ├─ probe.setup(sandbox)
         ├─ probe.run(sandbox) ─► ProbeOutcome { passed, reason, evidence }
         ├─ probe.teardown(sandbox)
         └─ sandbox.reset()      (D13 trigger; SandboxResetDivergenceError
                                 from A6-class probes is expected)
```

A `Probe` is `{ name, attackerClass, description, validatedAgainst, expectation, run(sandbox) }`. The runner wraps each probe with timing + per-probe budget enforcement and produces a `RedTeamReport` (schema v1.0).

## Probe matrix

| Probe                     | Attacker class | Tests                                                                                                                                                                                                                                                                 | Validation |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **P-A1-net-egress**       | A1             | Tool opens arbitrary outbound TCP. MUST fail.                                                                                                                                                                                                                         | mock-only  |
| **P-A2-fs-escape**        | A2             | Tool reads host `/etc/shadow`. MUST fail; marker MUST NOT leak.                                                                                                                                                                                                       | mock-only  |
| **P-A3-process-escape**   | A3             | Tool sends SIGTERM to host PID 1. MUST fail.                                                                                                                                                                                                                          | mock-only  |
| **P-A4-resource-exhaust** | A4             | Tool allocates 100 GiB / fork-bombs. MUST be killed.                                                                                                                                                                                                                  | mock-only  |
| **P-A5-time-bomb**        | A5             | Tool sleeps past `deadline_ms`. MUST throw `SandboxToolTimeoutError`.                                                                                                                                                                                                 | mock-only  |
| **P-A6-substrate-lie**    | A6             | Host mutates overlay between dispatches. Next `reset()` MUST detect divergence in 3-source verification (`divergence_action !== "none"`) AND throw `SandboxResetDivergenceError`. The headline integrity-check. Catches lying-VMM via independent host-side evidence. | mock-only  |
| **P-A7-stdout-injection** | A7             | Tool emits forged `CommandResult` JSON to stdout. Boundary MUST NOT promote it to a protocol frame.                                                                                                                                                                   | mock-only  |
| **P-A8-vsock-poison**     | A8             | Sandbox receives oversized / truncated / JSON-injection vsock frames. MUST reject without crashing; subsequent `executeTool` MUST succeed.                                                                                                                            | mock-only  |
| **P-LAT-boot**            | LAT            | 1000-iteration boot/shutdown distribution. p50/p90/p95/p99.                                                                                                                                                                                                           | mock-only  |
| **P-LAT-reset**           | LAT            | 1000-iteration reset distribution.                                                                                                                                                                                                                                    | mock-only  |
| **P-LAT-roundtrip**       | LAT            | 1000-iteration `executeTool(noop)` distribution.                                                                                                                                                                                                                      | mock-only  |

## Honest gap list

What this framework does **not** cover:

- **Crypto-side-channel** attacks (timing, cache, Spectre-class) — out of MVP.
- **Kernel-CVE chains** — needs a curated CVE corpus and an in-guest exploit harness; the image-builder pipeline (P3.4) owns that.
- **A4 build-time image compromise** — by definition baseline-compromised; integrity monitor cannot detect at runtime (threat-model §5.5).
- **A5 compromised host agent** — the monitor IS the agent; no probe here can detect it.
- **A9 cross-context replay** — covered by relay/operator-key tests, not the sandbox boundary.
- **A10 replay after agent restart** — same; covered by `@brainst0rm/relay` nonce-store tests.
- **Real CHV cow-overlay mutation** for P-A6 — needs the P3.4 image-builder overlay layout to be locked in. The probe currently returns "stubbed" when given a non-mock backend.
- **Real vsock poison framing** — needs `vsock-client.ts` CONNECT handshake to land first.
- **1000-iteration latency on real microVM** — mock numbers reflect Node event-loop overhead, not microVM reality.

## CLI

```bash
# Default: mock backend, full battery, JSON to stdout
npx bsm-redteam

# Once CHV first-boots on a Linux host:
bsm-redteam --sandbox chv --probes all --output /tmp/p35a-report.json

# Once VF first-boots on macOS:
bsm-redteam --sandbox vf --probes all --output /tmp/p35a-report.json

# Just adversarial probes (no latency battery):
bsm-redteam --sandbox mock --probes adversarial -o report.json

# Latency battery only, with a smaller iteration count:
bsm-redteam --sandbox mock --probes lat --iterations 100
```

Selecting `--sandbox chv|vf` on a host without that backend produces a clean skip report with a note in `report.notes` — exit code 0, but `summary.passed === 0`. CI consumers should assert on `summary.passed > 0` to catch silent skips.

Exit codes:

- `0` — clean report (no failures, no errors)
- `1` — at least one probe failed or errored
- `2` — CLI usage error

## Report schema (v1.0)

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "2026-04-27T12:00:00.000Z",
  "backend": "chv",
  "final_sandbox_state": "ready",
  "probes": [
    {
      "name": "P-A6-substrate-lie",
      "attacker_class": "A6",
      "expectation": "should-fail",
      "validated_against": "mock-only",
      "description": "...",
      "passed": true,
      "reason": "reset detected divergence: ...",
      "duration_ms": 12,
      "errored": false,
      "evidence": { "error_code": "SANDBOX_RESET_DIVERGENCE" },
    },
    // ...
  ],
  "latency": {
    "P-LAT-roundtrip": {
      "samples": 1000,
      "p50_ms": 0.05,
      "p90_ms": 0.12,
      "p95_ms": 0.18,
      "p99_ms": 0.31,
      "mean_ms": 0.07,
      "min_ms": 0.02,
      "max_ms": 1.4,
    },
  },
  "summary": {
    "total": 11,
    "passed": 11,
    "failed": 0,
    "errored": 0,
    "skipped": 0,
  },
  "notes": [],
}
```

## Building probes

Each probe is a plain object satisfying the `Probe` interface. The contract:

```ts
import type { Probe, ProbeOutcome } from "@brainst0rm/sandbox-redteam";
import type { Sandbox } from "@brainst0rm/sandbox";

export const myProbe: Probe = {
  name: "P-A3-fork-bomb",
  attackerClass: "A3",
  expectation: "should-fail",
  validatedAgainst: "mock-only", // bump to "validated-chv" once exercised
  description: "Tool fork-bombs the guest. cgroup pids.max should kill it.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const exec = await sandbox.executeTool({
      command_id: "fork-bomb",
      tool: "shell.exec",
      params: { cmd: ":(){ :|:& };:" },
      deadline_ms: 5_000,
    });
    return {
      passed: exec.exit_code !== 0,
      reason: `exit=${exec.exit_code}`,
      evidence: { exit_code: exec.exit_code },
    };
  },
};
```

When you exercise a probe against a real CHV/VF host, bump `validatedAgainst` to `"validated-chv"`, `"validated-vf"`, or `"validated-chv-and-vf"`. CI should fail the day all probes still say `"mock-only"` after first-boot.

## Why a separate package

This lives outside `@brainst0rm/sandbox` so the sandbox interface is not co-versioned with the red-team probes. Probes evolve faster than the boundary; pinning them in their own `0.1.0` package lets us iterate without forcing sandbox consumers to bump.
