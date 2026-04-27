// Thin wrapper around the `ch-remote` binary.
//
// Why a wrapper module: P3.2a needs to issue several `ch-remote` calls in
// the reset path (snapshot revert, resume, info). The wrapper centralises
// the argv shape, the JSON-parse for `info`, and — most importantly — the
// dependency-injection point used by the unit tests.
//
// On Linux against a real Cloud Hypervisor, this module spawns the
// `ch-remote` binary on $PATH (or wherever `ChvSandboxConfig.chRemoteBin`
// points) using Node's promisified `execFile` (no shell, argv-style). On
// Darwin (and in unit tests), the consumer injects a fake `ExecFileFn`
// that returns canned stdout/stderr without touching the host.
//
// Honesty: every exported function in this file has been exercised against
// a mock `ExecFileFn` in `__tests__/chv-sandbox-reset.test.ts`. None of
// them have been exercised against a real `ch-remote` binary in this
// checkout — that is 0bz7aztr's job on node-2 once this lands. The argv
// shape is taken from cloud-hypervisor v40+ documentation; the integration
// runner will surface any drift.
//
// Wire reference (from CHV `ch-remote --help` v40+):
//   ch-remote --api-socket <path> restore source_url=file://<dir>     # roll back
//   ch-remote --api-socket <path> snapshot destination_url=file://<dir> # create
//   ch-remote --api-socket <path> resume                              # un-pause
//   ch-remote --api-socket <path> info                                # vm.info JSON
//   ch-remote --api-socket <path> pause                               # pause VMM
//   ch-remote --api-socket <path> shutdown-vmm                        # stop + free
//
// NOTE: per the P3.2a wire-protocol spec, `snapshotRevert` here uses the
// `snapshot` verb pointing at the golden directory rather than the
// `restore` verb. This matches the prompt's protocol literally; if real
// CHV semantics expect `restore` instead, the integration runner will
// surface a non-zero exit and we patch the verb here. The tests pin the
// argv shape so any change is a one-line edit + obvious test diff.

import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import type { VmmApiState } from "@brainst0rm/relay";

import { SandboxResetError } from "../errors.js";

/**
 * Subset of Node's promisified `execFile` we depend on. Tests inject a
 * fake; production uses the real binary via argv-style invocation.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = promisify(
  nodeExecFile,
) as ExecFileFn;

export interface ChRemoteOptions {
  /** Binary name or absolute path. Defaults to `"ch-remote"`. */
  binary?: string;
  /** REST API socket path passed via `--api-socket`. Required. */
  apiSocketPath: string;
  /** Injection point. Defaults to Node's promisified argv-style invoker. */
  execFile?: ExecFileFn;
}

/**
 * Wrap the `ch-remote` invocations the reset path needs. Each method
 * takes its own option set so callers can compose without re-creating the
 * wrapper. (Reset issues 3 calls per cycle: revert, resume, info.)
 */
export class ChRemote {
  private readonly binary: string;
  private readonly apiSocketPath: string;
  private readonly invoke: ExecFileFn;

  constructor(opts: ChRemoteOptions) {
    this.binary = opts.binary ?? "ch-remote";
    this.apiSocketPath = opts.apiSocketPath;
    this.invoke = opts.execFile ?? defaultExecFile;
  }

  /**
   * Revert to a previously-created golden snapshot. Cloud Hypervisor's
   * `restore` endpoint requires the VMM to have NO existing VM — it
   * creates a fresh VM from the snapshot. Calling restore while a VM
   * is Running fails with `InternalServerError: "VM is already created"`
   * (caught on 0bz7aztr's run-3 with a Running VM that had just
   * dispatched a tool successfully).
   *
   * Correct sequence (per CHV state-machine semantics):
   *   1. ch-remote shutdown        # stop the running VM (guest off)
   *   2. ch-remote delete          # remove VM from VMM (slot empty)
   *   3. ch-remote restore         # load fresh VM from snapshot
   *   4. ch-remote resume          # un-pause the restored VM
   *
   * The VMM (cloud-hypervisor process) stays alive across all four
   * steps; only the VM-within-the-VMM gets cycled. Snapshot's symmetric
   * verb (snapshot create) only requires `pause` because it doesn't
   * touch the VM slot.
   *
   * Earlier history (commit log breadcrumbs):
   *   - First version used `snapshot fs://<path>` for revert (Codex
   *     round-2 catch — `snapshot` creates, `restore` reverts).
   *   - Round-3 fixed `snapshot destination_url=` → `snapshot
   *     file:///<dir>` (CHV's snapshot/restore argv shape is asymmetric).
   *   - This version (run-3 catch by 0bz7aztr) inserts shutdown+delete
   *     before restore so CHV accepts the call.
   *
   * Throws `SandboxResetError` if any of the four ch-remote calls
   * exits non-zero — the dispatcher handles this by halting the
   * sandbox (per threat-model §5.1 substrate-lying defense).
   */
  async snapshotRevert(snapshotPath: string): Promise<void> {
    const apiSocket = ["--api-socket", this.apiSocketPath];
    // 1. shutdown: stop the running VM
    try {
      await this.invoke(this.binary, [...apiSocket, "shutdown"]);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote shutdown failed: ${(e as Error).message}`,
        e,
      );
    }
    // 2. delete: remove the VM definition so the VMM slot is empty
    try {
      await this.invoke(this.binary, [...apiSocket, "delete"]);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote delete failed: ${(e as Error).message}`,
        e,
      );
    }
    // 3. restore: create fresh VM from snapshot
    const sourceUrl = `source_url=file://${snapshotPath}`;
    try {
      await this.invoke(this.binary, [...apiSocket, "restore", sourceUrl]);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote restore failed: ${(e as Error).message}`,
        e,
      );
    }
    // 4. resume: restored VM comes back paused, un-pause it
    try {
      await this.invoke(this.binary, [...apiSocket, "resume"]);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote resume failed: ${(e as Error).message}`,
        e,
      );
    }
  }

  /**
   * Pause the running VM via the VMM REST API. Used by the install-time
   * golden-snapshot flow: cloud-hypervisor requires the VM to be paused
   * before `snapshot destination_url=...` is accepted (otherwise the
   * snapshot call returns "VmNotPaused" and exits non-zero).
   *
   *   ch-remote --api-socket <path> pause
   *
   * Throws `SandboxResetError` on non-zero exit (consistent with
   * snapshotRevert's error handling — the install-time CLI catches and
   * exits with code 2).
   */
  async pause(): Promise<void> {
    try {
      await this.invoke(this.binary, [
        "--api-socket",
        this.apiSocketPath,
        "pause",
      ]);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote pause failed: ${(e as Error).message}`,
        e,
      );
    }
  }

  /**
   * Create a new snapshot at the given destination directory. This is the
   * symmetric verb to `snapshotRevert` — the install-time CLI uses it to
   * mint the golden snapshot that subsequent `restore` calls roll back to.
   *
   * **argv asymmetry with restore:** CHV's `snapshot` and `restore` use
   * DIFFERENT argv shapes (Codex round-3 catch, citing CHV docs at
   * https://intelkevinputnam.github.io/cloud-hypervisor-docs-HTML/docs/snapshot_restore.html):
   *
   *   ch-remote --api-socket <path> snapshot file:///<destDir>           # bare URL
   *   ch-remote --api-socket <path> restore source_url=file://<srcDir>   # key=value form
   *
   * Per cloud-hypervisor v40+ docs: the VM MUST be paused first (see
   * `pause()`). The destination must be a directory; CHV writes
   * `config.json`, `state.json`, and one `memory-ranges-*.bin` per region
   * inside it. Existing files in the directory are overwritten.
   *
   * Throws `SandboxResetError` on non-zero exit (consistent with the
   * other ch-remote verbs).
   */
  async snapshotCreate(destDir: string): Promise<void> {
    const destinationUrl = `file://${destDir}`;
    try {
      await this.invoke(this.binary, [
        "--api-socket",
        this.apiSocketPath,
        "snapshot",
        destinationUrl,
      ]);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote snapshot failed: ${(e as Error).message}`,
        e,
      );
    }
  }

  /**
   * Query the VMM's REST API for the current VM state. Returns the raw
   * state string normalised onto the protocol's `VmmApiState` vocabulary
   * (`running` | `paused` | `stopped` | `error`).
   *
   * Mapping (from CHV `vm.info` source — `arch/state.rs`):
   *   "Running"   -> "running"
   *   "Paused"    -> "paused"
   *   "Shutdown"  -> "stopped"   (canonical wire vocab uses stopped)
   *   "Created"   -> "stopped"   (created-but-not-running → stopped)
   *   anything else -> "error"   (forces divergence; loud failure)
   */
  async info(): Promise<{ raw: string; state: VmmApiState }> {
    const { stdout } = await this.invoke(this.binary, [
      "--api-socket",
      this.apiSocketPath,
      "info",
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new SandboxResetError(
        `ch-remote info returned non-JSON stdout: ${stdout.slice(0, 200)}`,
        e,
      );
    }
    const raw =
      parsed !== null &&
      typeof parsed === "object" &&
      "state" in parsed &&
      typeof (parsed as { state: unknown }).state === "string"
        ? ((parsed as { state: string }).state as string)
        : "";
    return { raw, state: normaliseVmmState(raw) };
  }
}

/**
 * Normalise CHV's `state` string into the protocol's canonical
 * `VmmApiState`. Unknown values map to `"error"` so divergence is loud
 * (per threat-model §5.1: a substrate-lying attacker may emit a novel
 * state string to dodge the verifier — we treat that as halt-worthy).
 */
export function normaliseVmmState(raw: string): VmmApiState {
  const lower = raw.toLowerCase();
  if (lower === "running") return "running";
  if (lower === "paused") return "paused";
  if (lower === "shutdown" || lower === "stopped" || lower === "created") {
    return "stopped";
  }
  return "error";
}
