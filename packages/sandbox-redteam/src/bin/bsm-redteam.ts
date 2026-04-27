#!/usr/bin/env node
// bsm-redteam — CLI for the P3.5a/P3.5b red-team battery.
//
// Modes:
//   1. Probe battery (legacy P3.5a, mock-only):
//        bsm-redteam --sandbox <chv|vf|mock> --probes <all|adversarial|lat>
//                    [--output report.json] [--iterations N]
//
//   2. Real-CHV latency battery (P3.5b):
//        bsm-redteam --probes lat-only --iterations N --output report.json
//      Uses the same env-var contract as packages/sandbox/scripts/first-light.sh
//      (BSM_KERNEL, BSM_INITRAMFS, BSM_ROOTFS, BSM_VSOCK_SOCKET,
//       BSM_API_SOCKET, BSM_GUEST_PORT, BSM_CH_BIN, BSM_CHREMOTE_BIN).
//      Each iteration is a fresh ChvSandbox: cold-boot + dispatch + shutdown.
//      Default N=1000.
//
//   3. Real-CHV concurrent stress (P3.5b):
//        bsm-redteam --probes concurrent --concurrency N --output report.json
//      Stands up N ChvSandbox instances in parallel (unique cid 3..3+N-1,
//      unique vsock + api sockets), boots them all, dispatches one echo
//      through each, shuts them all down. Default N=8.
//
// Exit codes:
//   0 — clean report (all probes passed, no errors, no failures)
//   1 — at least one probe failed or errored
//   2 — CLI usage error / sandbox could not be constructed / config missing
//
// Honesty: probes that genuinely run against a real CHV report
// `validated_against: "validated-chv"`. Probes still on mock substrate
// keep `validated_against: "mock-only"`. The report's notes section
// surfaces the count distinction.

import { writeFileSync } from "node:fs";

import { ChvSandbox } from "@brainst0rm/sandbox";

import {
  buildChvConfig,
  concurrentOverrides,
  DEFAULT_API_SOCKET,
  DEFAULT_VSOCK_SOCKET,
} from "../chv-config-builder.js";
import { MockSandbox } from "../mock-sandbox.js";
import { defenderToolBattery } from "../mock-tools.js";
import {
  ALL_ADVERSARIAL_PROBES,
  allProbes,
  makeLatencyBattery,
} from "../probes/index.js";
import {
  reportIsClean,
  serializeReport,
  summariseValidationProvenance,
} from "../reporter.js";
import { runConcurrentBattery, runLatencyBattery } from "../real-chv-runner.js";
import { RedTeamRunner } from "../runner.js";
import type { Probe, RedTeamReport } from "../types.js";

type SandboxBackend = "chv" | "vf" | "mock";
type ProbeMode = "all" | "adversarial" | "lat" | "lat-only" | "concurrent";

interface Args {
  sandbox: SandboxBackend;
  probes: ProbeMode;
  output?: string;
  iterations: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    sandbox: "mock",
    probes: "all",
    iterations: 1000,
    concurrency: 8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`flag ${tok} requires a value`);
      }
      return v;
    };
    if (tok === "--sandbox") {
      const v = next();
      if (v !== "chv" && v !== "vf" && v !== "mock") {
        throw new Error(`--sandbox must be chv|vf|mock, got ${v}`);
      }
      a.sandbox = v;
    } else if (tok === "--probes") {
      const v = next();
      if (
        v !== "all" &&
        v !== "adversarial" &&
        v !== "lat" &&
        v !== "lat-only" &&
        v !== "concurrent"
      ) {
        throw new Error(
          `--probes must be all|adversarial|lat|lat-only|concurrent, got ${v}`,
        );
      }
      a.probes = v;
    } else if (tok === "--output" || tok === "-o") {
      a.output = next();
    } else if (tok === "--iterations") {
      a.iterations = Number(next());
      if (!Number.isFinite(a.iterations) || a.iterations <= 0) {
        throw new Error(`--iterations must be a positive integer`);
      }
    } else if (tok === "--concurrency") {
      a.concurrency = Number(next());
      if (!Number.isFinite(a.concurrency) || a.concurrency <= 0) {
        throw new Error(`--concurrency must be a positive integer`);
      }
    } else if (tok === "--help" || tok === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${tok}`);
    }
  }
  return a;
}

function printHelp(): void {
  process.stdout.write(
    "bsm-redteam — Brainstorm sandbox red-team battery\n\n" +
      "Modes:\n" +
      "  --probes all|adversarial|lat        legacy P3.5a probe battery (--sandbox chv|vf|mock)\n" +
      "  --probes lat-only --iterations N    P3.5b cold-boot+exec+shutdown latency battery (real CHV)\n" +
      "  --probes concurrent --concurrency N P3.5b N-instance parallel stress (real CHV)\n\n" +
      "Required env (lat-only and concurrent modes — same as first-light.sh):\n" +
      "  BSM_KERNEL, BSM_ROOTFS, BSM_INITRAMFS (modular kernels), and\n" +
      "  optionally BSM_VSOCK_SOCKET, BSM_API_SOCKET, BSM_GUEST_PORT,\n" +
      "  BSM_CH_BIN, BSM_CHREMOTE_BIN.\n\n" +
      "Defaults: --sandbox mock --probes all --iterations 1000 --concurrency 8\n\n" +
      "Output:\n" +
      "  --output PATH    write JSON report to PATH (else stdout)\n",
  );
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`bsm-redteam: ${(e as Error).message}\n`);
    printHelp();
    process.exit(2);
  }

  // ---- P3.5b real-CHV modes ---------------------------------------------
  if (args.probes === "lat-only") {
    await runLatOnlyMode(args);
    return;
  }
  if (args.probes === "concurrent") {
    await runConcurrentMode(args);
    return;
  }

  // ---- P3.5a probe-battery modes (mock + skip-on-real) ------------------
  let probeSet: Probe[];
  if (args.probes === "all") {
    probeSet = allProbes({ iterations: args.iterations });
  } else if (args.probes === "adversarial") {
    probeSet = ALL_ADVERSARIAL_PROBES;
  } else {
    probeSet = makeLatencyBattery({ iterations: args.iterations });
  }

  if (args.sandbox === "chv" || args.sandbox === "vf") {
    process.stderr.write(
      `bsm-redteam: --sandbox ${args.sandbox} for adversarial probe batteries\n` +
        `(mock-substrate probes A1..A8) is intentionally surfacing as a\n` +
        `documented skip — these probes are still mock-only and should be\n` +
        `re-run only after their substrate is hardened (P3.2a for A6, etc.).\n` +
        `For real-CHV validation, use --probes lat-only or --probes concurrent.\n`,
    );
    const skipMock = new MockSandbox({
      backendLabel: args.sandbox,
      tools: defenderToolBattery(),
    });
    const origBoot = skipMock.boot.bind(skipMock);
    skipMock.boot = async (): Promise<void> => {
      const { SandboxNotAvailableError } = await import("@brainst0rm/sandbox");
      throw new SandboxNotAvailableError(
        `${args.sandbox} probe-battery not yet wired to real backend ` +
          `(P3.5b lat-only/concurrent modes ARE wired — use those)`,
      );
    };
    void origBoot;
    const runner = new RedTeamRunner(skipMock, { probes: probeSet });
    const report = await runner.run();
    finalize(report, args);
    return;
  }

  // mock
  const mock = new MockSandbox({
    backendLabel: "stub",
    tools: defenderToolBattery(),
  });
  const runner = new RedTeamRunner(mock, { probes: probeSet });
  const report = await runner.run();
  finalize(report, args);
}

async function runLatOnlyMode(args: Args): Promise<void> {
  let built: ReturnType<typeof buildChvConfig>;
  try {
    built = buildChvConfig();
  } catch (e) {
    process.stderr.write(`bsm-redteam: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const eff = built.effective;
  process.stderr.write(
    `bsm-redteam[lat-only]: kernel=${eff.kernel}\n` +
      `bsm-redteam[lat-only]: initramfs=${eff.initramfs ?? "(none)"}\n` +
      `bsm-redteam[lat-only]: rootfs=${eff.rootfs}\n` +
      `bsm-redteam[lat-only]: vsock=${eff.vsockSocket} api=${eff.apiSocket} cid=${eff.cid}\n` +
      `bsm-redteam[lat-only]: iterations=${args.iterations}\n`,
  );

  // The factory creates a fresh ChvSandbox per iteration. Each iteration
  // also gets its own per-iter socket paths so a botched shutdown can't
  // leave a stale socket file that blocks the next iter's CHV bind.
  const factory = (i: number): ChvSandbox => {
    const overrides = {
      // Always use a fresh socket suffix so a partial shutdown can't bork
      // the next iter. CID stays at the default (single-instance path).
      vsockSocketPath: `${eff.vsockSocket}.iter${i}`,
      apiSocketPath: `${eff.apiSocket}.iter${i}`,
    };
    const { config } = buildChvConfig(undefined, overrides);
    return new ChvSandbox(config);
  };

  const report = await runLatencyBattery(factory, {
    iterations: args.iterations,
    backendLabel: "chv",
    validatedAgainst: "validated-chv",
    onProgress: (done, total): void => {
      process.stderr.write(`bsm-redteam[lat-only]: iter ${done}/${total}\n`);
    },
  });
  finalize(report, args);
}

async function runConcurrentMode(args: Args): Promise<void> {
  let built: ReturnType<typeof buildChvConfig>;
  try {
    built = buildChvConfig();
  } catch (e) {
    process.stderr.write(`bsm-redteam: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const eff = built.effective;
  process.stderr.write(
    `bsm-redteam[concurrent]: kernel=${eff.kernel}\n` +
      `bsm-redteam[concurrent]: rootfs=${eff.rootfs}\n` +
      `bsm-redteam[concurrent]: concurrency=${args.concurrency} ` +
      `(cids ${3}..${3 + args.concurrency - 1})\n`,
  );

  // Per-instance factory: shard sockets and CIDs so the N sandboxes
  // genuinely don't collide.
  const baseVsock = eff.vsockSocket || DEFAULT_VSOCK_SOCKET;
  const baseApi = eff.apiSocket || DEFAULT_API_SOCKET;
  const factory = (i: number): ChvSandbox => {
    const overrides = concurrentOverrides(i, baseVsock, baseApi);
    const { config } = buildChvConfig(undefined, overrides);
    return new ChvSandbox(config);
  };

  const report = await runConcurrentBattery(factory, {
    concurrency: args.concurrency,
    backendLabel: "chv",
    validatedAgainst: "validated-chv",
  });
  finalize(report, args);
}

function finalize(report: RedTeamReport, args: Args): void {
  // Append a provenance summary to the report's notes so the report itself
  // carries the honesty marker (independent of stderr).
  const provenance = summariseValidationProvenance(report);
  report.notes.push(
    `validation-provenance: ` +
      `mock-only=${provenance.mockOnly} ` +
      `validated-chv=${provenance.validatedChv} ` +
      `validated-vf=${provenance.validatedVf} ` +
      `validated-chv-and-vf=${provenance.validatedChvAndVf} ` +
      `(total=${provenance.total})`,
  );

  const json = serializeReport(report);
  if (args.output !== undefined) {
    writeFileSync(args.output, json);
    process.stderr.write(`bsm-redteam: report written to ${args.output}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
  process.stderr.write(
    `bsm-redteam: total=${report.summary.total} ` +
      `passed=${report.summary.passed} ` +
      `failed=${report.summary.failed} ` +
      `errored=${report.summary.errored} ` +
      `skipped=${report.summary.skipped}\n`,
  );
  process.stderr.write(
    `bsm-redteam: provenance mock-only=${provenance.mockOnly} ` +
      `validated-chv=${provenance.validatedChv} ` +
      `validated-vf=${provenance.validatedVf}\n`,
  );
  process.exit(reportIsClean(report) ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`bsm-redteam: ${(e as Error).message}\n`);
  process.exit(2);
});
