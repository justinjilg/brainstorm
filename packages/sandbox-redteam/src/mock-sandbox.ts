// MockSandbox — in-process Sandbox impl used to test the framework
// itself, and as the default surface against which probes can be
// developed before a real CHV/VF host is available.
//
// Behaviour model:
//   - `boot()` flips state to "ready" after a configurable delay
//   - `executeTool()` runs a per-tool handler synchronously and respects
//     `deadline_ms` (throws SandboxToolTimeoutError when exceeded)
//   - `reset()` consults a tracked "overlay" map and produces a
//     ResetState with 3-source verification details. If something
//     external mutated the overlay since baseline (the A6 substrate-lying
//     case), divergence_action becomes "halt" and SandboxResetDivergenceError
//     is thrown — exactly mirroring ChvSandbox semantics.
//
// This is NOT a security boundary. Probes that need a "real" attack
// containment guarantee must be re-run against CHV/VF.

import {
  SandboxNotAvailableError,
  SandboxResetDivergenceError,
  SandboxResetError,
  SandboxToolTimeoutError,
  makeVerificationDetails,
  type ResetState,
  type Sandbox,
  type SandboxBackend,
  type SandboxState,
  type ToolExecution,
  type ToolInvocation,
  type VerificationDetails,
} from "@brainst0rm/sandbox";

export type MockToolHandler = (
  invocation: ToolInvocation,
  // Mutators the handler can use to model attacker behaviour.
  ctx: MockToolContext,
) => Promise<ToolExecution> | ToolExecution;

export interface MockToolContext {
  /**
   * Mutate the in-process "overlay" filesystem the next reset will hash.
   * Used by P-A6 / containment probes that simulate tool-side persistence.
   */
  writeOverlay(path: string, contents: string): void;
  /** Read overlay (mostly for tests). */
  readOverlay(path: string): string | undefined;
  /** Snapshot a host fact a probe may want to assert against. */
  recordHostFact(key: string, value: unknown): void;
}

export interface MockSandboxConfig {
  /** Tool name -> handler. Unknown tool names produce exit_code=127. */
  tools?: Record<string, MockToolHandler>;
  /** ms to wait inside boot() / reset(). Default 1ms each. */
  bootLatencyMs?: number;
  resetLatencyMs?: number;
  /**
   * If true, the next `reset()` reports divergence regardless of overlay
   * state. Used by P-A6 probes that need a "lying VMM" scenario without
   * actually mutating the overlay. Cleared after one use.
   */
  forceNextResetDivergence?: boolean;
  /**
   * If true, the next `reset()` throws SandboxResetError (machinery
   * failure path, distinct from divergence).
   */
  forceNextResetError?: boolean;
  /**
   * Whether the mock should claim divergence when overlay diverges from
   * baseline. Default true — set to false to model an A6 substrate-lying
   * VMM that pretends nothing happened. P-A6 inverts this to verify the
   * runner notices the lie via independent host-side evidence.
   */
  honestReset?: boolean;
  /** Optional label override (default "stub"). */
  backendLabel?: SandboxBackend;
}

export class MockSandbox implements Sandbox {
  public readonly backend: SandboxBackend;

  private status: SandboxState = "not_booted";
  private readonly tools: Record<string, MockToolHandler>;
  private readonly bootLatencyMs: number;
  private readonly resetLatencyMs: number;
  private honestReset: boolean;
  private forceNextResetDivergence: boolean;
  private forceNextResetError: boolean;

  // The overlay represents the post-baseline mutable substrate. Both
  // tools (via MockToolContext) and external host actors (via the
  // public `hostMutateOverlay` method, modelling A6) can write here.
  private overlay = new Map<string, string>();
  // Snapshot of overlay at boot — the "golden" baseline.
  private baseline = new Map<string, string>();
  private hostFacts = new Map<string, unknown>();

  constructor(config: MockSandboxConfig = {}) {
    this.tools = config.tools ?? {};
    this.bootLatencyMs = config.bootLatencyMs ?? 1;
    this.resetLatencyMs = config.resetLatencyMs ?? 1;
    this.honestReset = config.honestReset ?? true;
    this.forceNextResetDivergence = config.forceNextResetDivergence ?? false;
    this.forceNextResetError = config.forceNextResetError ?? false;
    this.backend = config.backendLabel ?? "stub";
  }

  state(): SandboxState {
    return this.status;
  }

  async boot(): Promise<void> {
    if (this.status === "ready" || this.status === "booting") return;
    this.status = "booting";
    await sleep(this.bootLatencyMs);
    // Capture baseline after "boot" so the first reset is a no-op.
    this.baseline = new Map(this.overlay);
    this.status = "ready";
  }

  async executeTool(invocation: ToolInvocation): Promise<ToolExecution> {
    if (this.status !== "ready") {
      throw new SandboxNotAvailableError(
        `executeTool called with status=${this.status}`,
      );
    }
    const handler = this.tools[invocation.tool];
    if (handler === undefined) {
      // Unknown tool — surface as nonzero exit (matches a real shell).
      return {
        exit_code: 127,
        stdout: "",
        stderr: `unknown tool: ${invocation.tool}`,
      };
    }
    const ctx: MockToolContext = {
      writeOverlay: (p, c) => {
        this.overlay.set(p, c);
      },
      readOverlay: (p) => this.overlay.get(p),
      recordHostFact: (k, v) => {
        this.hostFacts.set(k, v);
      },
    };
    return runWithDeadline(handler(invocation, ctx), invocation.deadline_ms);
  }

  async reset(): Promise<ResetState> {
    if (this.status !== "ready") {
      throw new SandboxResetError(
        `reset called with status=${this.status}; sandbox must be ready`,
      );
    }
    this.status = "resetting";
    await sleep(this.resetLatencyMs);

    if (this.forceNextResetError) {
      this.forceNextResetError = false;
      this.status = "failed";
      throw new SandboxResetError("forced reset machinery failure");
    }

    // Compute fs_hash = serialized overlay. Honest impl reflects current
    // overlay; lying impl pretends overlay matches baseline.
    const trueHash = serializeOverlay(this.overlay);
    const baselineHash = serializeOverlay(this.baseline);
    const reportedHash = this.honestReset ? trueHash : baselineHash;

    let verification: VerificationDetails = makeVerificationDetails({
      fs_hash: reportedHash,
      fs_hash_baseline: baselineHash,
      open_fd_count: 0,
      open_fd_count_baseline: 0,
      vmm_api_state: "running",
      expected_vmm_api_state: "running",
    });

    if (this.forceNextResetDivergence) {
      this.forceNextResetDivergence = false;
      verification = {
        ...verification,
        fs_hash: "sha256:" + "f".repeat(64),
        fs_hash_match: false,
        divergence_action: "halt",
      };
    }

    const divergent = verification.divergence_action !== "none";
    if (divergent) {
      this.status = "failed";
      throw new SandboxResetDivergenceError(
        `mock reset detected divergence: fs_match=${verification.fs_hash_match}`,
      );
    }

    // Honest reset: revert overlay to baseline.
    this.overlay = new Map(this.baseline);
    this.status = "ready";
    return {
      reset_at: new Date().toISOString(),
      golden_hash: baselineHash,
      verification_passed: true,
      verification_details: verification,
    };
  }

  async shutdown(): Promise<void> {
    this.status = "not_booted";
  }

  // ---- mock-only helpers (NOT part of the Sandbox interface) -------------

  /**
   * Simulate the host substrate mutating the sandbox's overlay between
   * dispatches. Pure A6 vector — no in-guest actor caused this. The
   * next reset MUST detect divergence in the 3-source verification.
   */
  hostMutateOverlay(path: string, contents: string): void {
    this.overlay.set(path, contents);
  }

  /**
   * Configure the mock to lie on its NEXT reset call: the reported
   * fs_hash will match baseline even though overlay diverges. This
   * models a substrate-lying VMM. Independent host-side evidence (a
   * file the *probe* wrote that the runner can re-read) is what should
   * still surface the discrepancy.
   */
  beLyingResetOnce(): void {
    this.honestReset = false;
    queueMicrotask(() => {
      // Re-honest after one cycle — keeps default behaviour clean.
      this.honestReset = true;
    });
  }

  /** Inspect host facts (for assertions). */
  getHostFact(key: string): unknown {
    return this.hostFacts.get(key);
  }

  /** Inspect overlay (for assertions). */
  getOverlay(): ReadonlyMap<string, string> {
    return this.overlay;
  }

  /** Force an outcome on next reset (test convenience). */
  configureNextReset(opts: { divergence?: boolean; error?: boolean }): void {
    if (opts.divergence) this.forceNextResetDivergence = true;
    if (opts.error) this.forceNextResetError = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function serializeOverlay(m: Map<string, string>): string {
  // Deterministic sort+concat. Real CHV does sha256 over disk image,
  // not this — see threat-model §5.1.
  const sorted = [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  const blob = sorted.map(([k, v]) => `${k} ${v}`).join("");
  return "mock-fs-hash:" + blob.length + ":" + simpleHash(blob);
}

function simpleHash(s: string): string {
  // Non-cryptographic — sufficient for the mock. Real CHV uses SHA-256.
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function runWithDeadline<T>(
  pOrValue: Promise<T> | T,
  deadlineMs: number,
): Promise<T> {
  const p = Promise.resolve(pOrValue);
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new SandboxToolTimeoutError(
          deadlineMs,
          `tool exceeded deadline_ms=${deadlineMs}`,
        ),
      );
    }, deadlineMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
