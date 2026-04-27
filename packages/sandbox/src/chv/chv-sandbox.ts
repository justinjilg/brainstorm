// ChvSandbox — Cloud Hypervisor backend for the Sandbox interface.
//
// Honesty boundary: this class wires together the pieces P3.1a and P3.2a
// need (subprocess spawn, vsock client, snapshot/restore via ch-remote,
// real 3-source reset verification) into a single object that satisfies
// `Sandbox`.
//
// First-light status (2026-04 on node-2): boot works, vsock RPC works,
// echo round-trips. Reset machinery (P3.2a — this file's revised
// `reset()` / `snapshotRevert()` / `verifyPostReset()`) is host-side
// code; full validation against a real `ch-remote` and a real golden
// snapshot happens on a CHV runner per the README first-light checklist.
//
// On Darwin: `boot()` throws `SandboxNotAvailableError` cleanly. The
// reset machinery in this file is exercised only against mocked
// `ExecFileFn` / `HashFileFn` / vsock implementations in unit tests.

import { stat } from "node:fs/promises";

import {
  SandboxBootError,
  SandboxNotAvailableError,
  SandboxResetDivergenceError,
  SandboxResetError,
  SandboxVsockHandshakeError,
} from "../errors.js";
import {
  type ResetState,
  type Sandbox,
  type SandboxBackend,
  type SandboxState,
  type ToolExecution,
  type ToolInvocation,
  type VerificationDetails,
  type VmmApiState,
  makeVerificationDetails,
} from "../sandbox.js";
import { type ChvSandboxConfig, DEFAULT_VSOCK_CID } from "./chv-config.js";
import {
  defaultHashFile,
  FS_HASH_NOT_CONFIGURED,
  type HashFileFn,
} from "./chv-overlay-hash.js";
import { ChRemote, defaultExecFile, type ExecFileFn } from "./chv-remote.js";
import {
  assertChvAvailable,
  buildChvArgv,
  type ChvProcessHandle,
  spawnCloudHypervisor,
} from "./chv-process.js";
import { VsockClient } from "./vsock-client.js";

/**
 * Minimal vsock-shaped surface used by reset's open-fd verification
 * source. The real `VsockClient.guestQuery` satisfies this; tests
 * inject a fake.
 */
export interface VsockGuestQueryClient {
  guestQuery(kind: "OpenFdCount"): Promise<{ open_fd_count: number }>;
}

/**
 * Test-injection seam. Production code passes nothing and the defaults
 * (real `execFile`, real streaming SHA-256) take over. Unit tests pass
 * an in-memory mock for each.
 */
export interface ChvSandboxDeps {
  /** Replace ch-remote's argv-style invoker (tests). */
  execFile?: ExecFileFn;
  /** Replace the streaming SHA-256 (tests). */
  hashFile?: HashFileFn;
  /**
   * Inject a fake guest-query client (tests). When set, reset's
   * open-fd source uses this instead of `this.vsock`. Production
   * leaves this undefined — the real vsock connection is used.
   */
  vsock?: VsockGuestQueryClient;
}

/**
 * Marker emitted in `verification_details.fs_hash` when no baseline is
 * configured. Distinct from a real hash so consumers can detect the
 * "not configured" case without re-reading the config.
 */
const FS_HASH_BASELINE_UNSET = FS_HASH_NOT_CONFIGURED;

export class ChvSandbox implements Sandbox {
  public readonly backend: SandboxBackend = "chv";

  private readonly config: ChvSandboxConfig;
  private readonly log: {
    info: (m: string) => void;
    error: (m: string) => void;
  };
  private readonly deps: ChvSandboxDeps;
  private readonly chRemote: ChRemote;
  private readonly hashFile: HashFileFn;

  private process: ChvProcessHandle | null = null;
  private vsock: VsockClient | null = null;
  private status: SandboxState = "not_booted";

  constructor(config: ChvSandboxConfig, deps: ChvSandboxDeps = {}) {
    this.config = {
      ...config,
      vsock: { cid: DEFAULT_VSOCK_CID, ...config.vsock },
    };
    this.log = config.logger ?? {
      info: (m) => console.log(`[chv-sandbox] ${m}`),
      error: (m) => console.error(`[chv-sandbox] ${m}`),
    };
    this.deps = deps;
    this.chRemote = new ChRemote({
      binary: config.chRemoteBin,
      apiSocketPath: config.apiSocketPath,
      execFile: deps.execFile ?? defaultExecFile,
    });
    this.hashFile = deps.hashFile ?? defaultHashFile;
  }

  state(): SandboxState {
    return this.status;
  }

  async boot(): Promise<void> {
    if (this.status === "ready" || this.status === "booting") return;
    this.status = "booting";
    try {
      const { cloudHypervisorBin } = await assertChvAvailable(this.config);
      const argv = buildChvArgv(this.config);
      this.log.info(
        `spawning ${cloudHypervisorBin} with kernel=${this.config.kernel.path} rootfs=${this.config.rootfs.path}`,
      );
      this.process = spawnCloudHypervisor(cloudHypervisorBin, argv, this.log);

      // CHV needs hundreds of ms to start, parse argv, and bind both the
      // REST API socket and the vsock UNIX socket. Polling for the vsock
      // socket file is the cheapest readiness signal; we cap it at 30s
      // and bail early if the child process exits before the socket
      // appears (early-exit usually means CHV failed argv parsing or hit
      // a permissions error — surface its stderr in the error message).
      await this.waitForSocket(
        this.config.vsock.socketPath,
        30_000,
        this.process,
      );

      // The AF_UNIX socket file exists from CHV-start, but CHV's bridge
      // closes the connection if the guest's accept() loop isn't running
      // yet — visible to us as
      // "socket closed during handshake (peer hung up before sending OK)".
      // Retry the CONNECT/OK handshake with backoff until either the
      // guest's vsock listener is ready or we hit the cap. (0bz7aztr,
      // first-light run #8: the guest takes ~hundreds of ms to reach the
      // accept loop after CHV announces the bridge.)
      this.vsock = await this.openVsockWithRetry(30_000);

      this.status = "ready";
    } catch (e) {
      this.status = "failed";
      // Kill the orphaned CHV child if boot failed mid-flight. Without
      // this the parent process exits but cloud-hypervisor keeps running
      // — observed by 0bz7aztr on first-light run #2 (PID had to be
      // pkill'd manually). SIGTERM first; the child handles it cleanly.
      if (this.process !== null) {
        try {
          this.process.child.kill("SIGTERM");
        } catch {
          // Already exited or never started — nothing to do.
        }
        this.process = null;
      }
      // Pass-through SandboxNotAvailableError unchanged (Darwin path);
      // wrap anything else as SandboxBootError.
      if (e instanceof SandboxNotAvailableError) throw e;
      throw new SandboxBootError(`boot failed: ${(e as Error).message}`, e);
    }
  }

  async executeTool(invocation: ToolInvocation): Promise<ToolExecution> {
    if (this.status !== "ready" || this.vsock === null) {
      throw new SandboxNotAvailableError(
        `executeTool called with status=${this.status}`,
      );
    }
    return this.vsock.sendCommand(invocation);
  }

  /**
   * Expose `guestQuery` over the same vsock connection that runtime
   * `reset()` uses. The install-time golden-snapshot CLI calls this to
   * record the OpenFdCount baseline — using the SAME connection
   * eliminates the probe-FD-overhead asymmetry that a parallel
   * VsockClient would introduce. (Codex round-3 catch: opening a
   * second client adds an FD the runtime path won't see, baking a
   * stale baseline that diverges on first reset.)
   */
  async guestQuery(kind: "OpenFdCount"): Promise<{ open_fd_count: number }> {
    if (this.status !== "ready" || this.vsock === null) {
      throw new SandboxNotAvailableError(
        `guestQuery called with status=${this.status}`,
      );
    }
    const result = await this.vsock.guestQuery(kind);
    if (
      result === null ||
      typeof result !== "object" ||
      !("open_fd_count" in result) ||
      typeof (result as { open_fd_count: unknown }).open_fd_count !== "number"
    ) {
      throw new SandboxNotAvailableError(
        `OpenFdCount returned unexpected shape: ${JSON.stringify(result)}`,
      );
    }
    return {
      open_fd_count: (result as { open_fd_count: number }).open_fd_count,
    };
  }

  async reset(): Promise<ResetState> {
    if (this.status !== "ready") {
      throw new SandboxResetError(
        `reset called with status=${this.status}; sandbox must be ready`,
      );
    }
    this.status = "resetting";
    try {
      // Step 1: revert to the golden snapshot (or no-op if not configured).
      // The CHV state-machine sequence (shutdown → delete → restore →
      // resume) cycles the VM-within-the-VMM, so the host's existing
      // vsock connection — bound to pre-restore guest socket state —
      // is dead by the time we return. (0bz7aztr's run-4 catch.)
      await this.snapshotRevert();

      // Step 1b: re-establish the vsock connection. The pre-existing
      // `this.vsock` was invalidated by CHV's restore (it replaced the
      // entire kernel including the socket table). Without this step
      // the open-fd source in verifyPostReset would see "vsock closed"
      // and false-positive a divergence on every reset.
      //
      // Threat-model §A6 design said "use the same connection runtime
      // and install-time both use" — but "same connection" can't
      // survive a restore. The design's intent (FD-overhead symmetry)
      // is preserved by using the same connection-shape: one host
      // CONNECT bound to the same guest port. Install-time records its
      // baseline through this same shape, runtime queries through this
      // same shape, so probe overhead matches even though the literal
      // socket object has been replaced.
      // Skip when `deps.vsock` is injected — that's the test seam, and
      // tests expect the injected mock to represent the post-restore
      // state without needing a real CHV vsock socket on disk.
      if (this.snapshotConfigured() && this.deps.vsock === undefined) {
        if (this.vsock !== null) {
          // Best-effort close; the prior vsock is dead anyway.
          await this.vsock.close().catch(() => {});
          this.vsock = null;
        }
        this.vsock = await this.openVsockWithRetry(30_000);
      }

      // Step 2: 3-source verification. Each source compares against a
      // baseline; any disagreement -> halt (per threat-model §5.1).
      const verification = await this.verifyPostReset();

      // makeVerificationDetails sets divergence_action = "halt" iff any
      // of the three sources disagrees with its baseline. We re-derive
      // that here so the failure path is explicit and auditable.
      const diverged = verification.divergence_action === "halt";
      if (diverged) {
        this.status = "failed";
        throw new SandboxResetDivergenceError(
          `reset verification diverged: ` +
            `fs_match=${verification.fs_hash_match} ` +
            `fd_match=${verification.open_fd_count === verification.open_fd_count_baseline} ` +
            `vmm_match=${verification.vmm_api_state === verification.expected_vmm_api_state} ` +
            `(divergence_action=halt)`,
        );
      }

      this.status = "ready";
      return {
        reset_at: new Date().toISOString(),
        // The golden hash is the install-time baseline if configured; if
        // baselines are unset we surface the explicit "not configured"
        // marker so the dispatcher / audit log can flag the verification
        // posture clearly.
        golden_hash: this.config.baselines?.fs_hash ?? FS_HASH_BASELINE_UNSET,
        verification_passed: true,
        verification_details: verification,
      };
    } catch (e) {
      if (e instanceof SandboxResetDivergenceError) throw e;
      this.status = "failed";
      throw new SandboxResetError(`reset failed: ${(e as Error).message}`, e);
    }
  }

  async shutdown(): Promise<void> {
    try {
      if (this.vsock !== null) {
        await this.vsock.close();
        this.vsock = null;
      }
    } catch (e) {
      this.log.error(`vsock close error: ${(e as Error).message}`);
    }
    if (this.process !== null) {
      try {
        // ch-remote shutdown is the polite path (clean VMM tear-down).
        // SIGTERM on the spawned process is the fallback.
        const invoke = this.deps.execFile ?? defaultExecFile;
        const binary = this.config.chRemoteBin ?? "ch-remote";
        await invoke(binary, [
          "--api-socket",
          this.config.apiSocketPath,
          "shutdown-vmm",
        ]);
      } catch (e) {
        this.log.error(
          `ch-remote shutdown failed (${(e as Error).message}); falling back to SIGTERM`,
        );
        try {
          this.process.child.kill("SIGTERM");
        } catch {}
      }
      this.process = null;
    }
    this.status = "not_booted";
  }

  // --- internals ---------------------------------------------------------

  /**
   * Revert to the golden snapshot via `ch-remote`. Per the P3.2a wire
   * protocol:
   *
   *   ch-remote --api-socket <path> snapshot fs://<snapshotPath>
   *   ch-remote --api-socket <path> resume
   *
   * If `config.snapshotPath` is unset, this is a no-op — appropriate for
   * unit-test mode and for early scaffolding where the install-time
   * golden-snapshot flow has not yet been wired. Verification still
   * runs after a no-op revert so the dispatcher can observe the
   * post-reset state.
   *
   * Errors from either ch-remote call are wrapped in `SandboxResetError`
   * by `ChRemote.snapshotRevert` and surface here unchanged.
   */
  /** True when a snapshotPath is configured — i.e. snapshotRevert
   *  actually reverts CHV state and the vsock connection needs to be
   *  re-established afterward. */
  private snapshotConfigured(): boolean {
    return this.config.snapshotPath !== undefined;
  }

  private async snapshotRevert(): Promise<void> {
    if (this.config.snapshotPath === undefined) {
      this.log.info(
        "no snapshotPath configured; skipping revert (test/scaffold mode)",
      );
      return;
    }
    await this.chRemote.snapshotRevert(this.config.snapshotPath);
  }

  /**
   * 3-source post-reset verification (threat model §5.1). Each source
   * contributes one signal:
   *
   *   1. FS hash       — SHA-256 of post-reset rootfs CoW *overlay* file
   *                      (NOT the read-only base disk — see overlayPath
   *                      in RootfsConfig). Hashing the base would miss
   *                      a substrate-lying attacker who mutates writes.
   *   2. open_fd_count — queried inside the guest via vsock GuestQuery
   *   3. vmm_api_state — `ch-remote info` returns running/paused/etc.
   *
   * Each source is compared against its baseline. If any disagrees, the
   * resulting `VerificationDetails.divergence_action` is "halt" and the
   * caller (`reset()`) throws `SandboxResetDivergenceError`.
   *
   * **Baselines or overlayPath unset → divergence (halt).** The earlier
   * scaffolding "soft-passed" with matching sentinels; Codex review
   * caught that as a substrate-lying-defense bypass. A production
   * endpoint MUST configure both `RootfsConfig.overlayPath` AND all
   * three `baselines.*` fields, or `reset()` halts. Configuring only
   * some sources is treated as misconfiguration; the missing source
   * forces divergence so operators see the gap immediately.
   */
  private async verifyPostReset(): Promise<VerificationDetails> {
    const baselines = this.config.baselines;
    // overlayPath defaults to rootfs.path (the file CHV's --disk points
    // at). Advanced operators using qcow2 backing-file or host-level
    // overlayfs override this; the default-to-path makes the simple
    // case work without configuration. Codex round-3 catch.
    const fsHashFile =
      this.config.rootfs.overlayPath ?? this.config.rootfs.path;

    // --- Source 1: FS hash of writable disk file ----------------------
    let fs_hash: string;
    let fs_hash_baseline: string;
    if (baselines?.fs_hash === undefined) {
      fs_hash = FS_HASH_BASELINE_UNSET + ":actual-missing";
      fs_hash_baseline = FS_HASH_BASELINE_UNSET + ":baseline-missing";
      this.log.error(
        `fs_hash baseline not configured; forcing divergence — ` +
          `configure baselines.fs_hash before claiming reset integrity`,
      );
    } else {
      fs_hash_baseline = baselines.fs_hash;
      try {
        fs_hash = await this.hashFile(fsHashFile);
      } catch (e) {
        // Hashing itself failed -> treat as divergence (loud failure).
        // makeVerificationDetails will mark fs_hash_match = false and
        // set divergence_action = "halt".
        this.log.error(
          `fs_hash computation failed: ${(e as Error).message} (treating as divergence)`,
        );
        fs_hash = "sha256:hash-error";
      }
    }

    // --- Source 2: open-fd count via vsock GuestQuery ----------------
    let open_fd_count: number;
    let open_fd_count_baseline: number;
    if (baselines?.open_fd_count === undefined) {
      // Baseline unset → force divergence rather than fabricating a
      // soft-pass. -1 vs -2 sentinels guarantee mismatch.
      open_fd_count = -2;
      open_fd_count_baseline = -1;
      this.log.error(
        "open_fd_count baseline not configured; forcing divergence",
      );
    } else {
      open_fd_count_baseline = baselines.open_fd_count;
      // Tests inject a `VsockGuestQueryClient` directly; production
      // uses the real `VsockClient` opened during boot. Both expose a
      // `guestQuery("OpenFdCount")` shape — the real client returns a
      // wider union, so we narrow by checking for the expected field.
      const queryClient = this.deps.vsock ?? this.vsock;
      if (queryClient === null) {
        // We're configured to verify but have no vsock -> implementation
        // error (reset called without boot). Treat as divergence:
        // better to halt than fabricate a passing reading.
        this.log.error(
          "open_fd_count baseline configured but vsock client unavailable",
        );
        open_fd_count = -1;
      } else {
        try {
          const result = await queryClient.guestQuery("OpenFdCount");
          if (
            result !== null &&
            typeof result === "object" &&
            "open_fd_count" in result &&
            typeof (result as { open_fd_count: unknown }).open_fd_count ===
              "number"
          ) {
            open_fd_count = (result as { open_fd_count: number }).open_fd_count;
          } else {
            this.log.error(
              `open_fd_count query returned unexpected shape: ${JSON.stringify(result)}`,
            );
            open_fd_count = -1;
          }
        } catch (e) {
          this.log.error(
            `open_fd_count query failed: ${(e as Error).message} (treating as divergence)`,
          );
          open_fd_count = -1;
        }
      }
    }

    // --- Source 3: VMM API state via ch-remote info ------------------
    let vmm_api_state: VmmApiState;
    let expected_vmm_api_state: VmmApiState;
    if (baselines?.expected_vmm_api_state === undefined) {
      // Baseline unset → force divergence. We still emit `live` for
      // audit traceability, but the baseline sentinel won't match.
      try {
        const live = await this.chRemote.info();
        vmm_api_state = live.state;
      } catch (e) {
        this.log.error(
          `ch-remote info failed: ${(e as Error).message} (recording as 'error')`,
        );
        vmm_api_state = "error";
      }
      // "error" is in the VmmApiState union; using it as a baseline
      // value here is fine and guaranteed to mismatch any live "running"
      // / "paused" / "stopped" reading.
      expected_vmm_api_state = "error";
      this.log.error(
        "expected_vmm_api_state baseline not configured; forcing divergence",
      );
    } else {
      expected_vmm_api_state = baselines.expected_vmm_api_state;
      try {
        const live = await this.chRemote.info();
        vmm_api_state = live.state;
      } catch (e) {
        // ch-remote unreachable post-reset is itself a divergence — the
        // VMM may have crashed during revert. Loud-fail.
        this.log.error(
          `ch-remote info failed post-reset: ${(e as Error).message} (treating as divergence)`,
        );
        vmm_api_state = "error";
      }
    }

    return makeVerificationDetails({
      fs_hash,
      fs_hash_baseline,
      open_fd_count,
      open_fd_count_baseline,
      vmm_api_state,
      expected_vmm_api_state,
    });
  }

  /**
   * Repeatedly attempt the CHV CONNECT/OK handshake until the guest's
   * accept loop is ready (or we hit the timeout). Each handshake-failure
   * is treated as "guest not yet ready" and retried after a 250ms
   * backoff; non-handshake errors propagate immediately.
   */
  private async openVsockWithRetry(timeoutMs: number): Promise<VsockClient> {
    const start = Date.now();
    let attempt = 0;
    let lastErr: Error | null = null;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      const client = new VsockClient({
        socketPath: this.config.vsock.socketPath,
        guestPort: this.config.vsock.guestPort,
        logger: this.log,
      });
      try {
        await client.open();
        if (attempt > 1) {
          this.log.info(
            `[vsock] handshake succeeded on attempt ${attempt} (took ${Date.now() - start}ms total)`,
          );
        }
        return client;
      } catch (e) {
        lastErr = e as Error;
        if (!(e instanceof SandboxVsockHandshakeError)) {
          // Non-handshake error: don't retry (e.g. SandboxNotAvailableError).
          throw e;
        }
        // Handshake-failure is the expected race signal during boot.
        await client.close().catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new SandboxBootError(
      `vsock handshake never succeeded within ${timeoutMs}ms (last error: ${lastErr?.message ?? "unknown"})`,
      lastErr ?? undefined,
    );
  }

  /**
   * Poll for a Unix socket file to appear at `path`. Returns once stat
   * succeeds; throws on timeout or if the CHV child process exits before
   * the socket appears (early exit usually means argv parse / permission
   * failure — the caller's logger has already captured CHV's stderr).
   */
  private async waitForSocket(
    path: string,
    timeoutMs: number,
    chv: ChvProcessHandle,
  ): Promise<void> {
    const intervalMs = 50;
    const start = Date.now();
    type ExitInfo = {
      code: number | null;
      signal: NodeJS.Signals | null;
    };
    const exitRef: { value: ExitInfo | null } = { value: null };
    void chv.exited.then((info) => {
      exitRef.value = info;
    });

    while (true) {
      try {
        await stat(path);
        return;
      } catch {
        // socket not yet present
      }
      if (exitRef.value !== null) {
        const ev = exitRef.value;
        throw new SandboxBootError(
          `cloud-hypervisor exited before vsock socket appeared at ${path} ` +
            `(code=${ev.code} signal=${ev.signal}); ` +
            `check the [chv stderr] log lines above for the cause`,
        );
      }
      if (Date.now() - start > timeoutMs) {
        throw new SandboxBootError(
          `vsock socket did not appear at ${path} within ${timeoutMs}ms ` +
            `(cloud-hypervisor still alive — guest may have wedged or argv may be wrong)`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // Test-only state: `__tests__/chv-sandbox-reset.test.ts` reaches in via
  // `as any` to set `status = "ready"` and inject a fake vsock without a
  // real boot. We deliberately don't expose a public hook — keeping the
  // shape minimal forces tests to be honest about what they're poking.
}
