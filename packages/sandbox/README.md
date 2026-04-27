# @brainst0rm/sandbox

MicroVM sandbox abstraction for the Brainstorm endpoint agent.

This is **P3.1a scaffolding**, not a runnable VM. It was authored on Darwin
and **has not been booted against a real `cloud-hypervisor` binary**. The
goal of this package today is to nail down the cross-backend interface,
freeze the protocol-shape contracts (`ResetState`, `VerificationDetails`),
and leave a Linux runner a small, well-documented set of pieces to fill in
for first light.

## What's in here

| File                          | Status      | Notes                                                                                                                                                                                         |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sandbox.ts`              | implemented | Abstract `Sandbox` interface, `ToolInvocation`, `ToolExecution`, `ResetState` re-export, `makeVerificationDetails` helper                                                                     |
| `src/errors.ts`               | implemented | `SandboxNotAvailableError`, `SandboxBootError`, `SandboxToolTimeoutError`, `SandboxToolError`, `SandboxResetError`, `SandboxResetDivergenceError` — codes match the protocol error vocabulary |
| `src/chv/chv-config.ts`       | implemented | `ChvSandboxConfig`, `KernelConfig`, `RootfsConfig`, `VsockConfig`, defaults                                                                                                                   |
| `src/chv/chv-process.ts`      | partial     | Builds CHV argv, spawns the binary, refuses cleanly on non-Linux. **Validated on node-2 first-light (PR #277).**                                                                              |
| `src/chv/vsock-client.ts`     | implemented | CHV `CONNECT <port>` handshake + length-prefixed JSON RPC loop. Validated end-to-end on node-2 (echo round-trip, 600ms boot / 2ms exec).                                                      |
| `src/chv/chv-sandbox.ts`      | partial     | Boot / exec / shutdown validated on node-2. **Reset machinery (P3.2a) is host-side code only — full validation requires a real install-time golden-snapshot flow.**                           |
| `src/chv/chv-remote.ts`       | implemented | `ch-remote` argv wrapper (`snapshot fs://`, `resume`, `info`) with injectable `ExecFileFn` for tests. Argv shape pinned by unit tests; semantics await node-2 integration.                    |
| `src/chv/chv-overlay-hash.ts` | implemented | Streaming SHA-256 hasher over the rootfs CoW overlay file; injectable `HashFileFn` for tests. **No real overlay file has been hashed in this checkout.**                                      |

## P3.2a — Linux reset machinery (host-side code, host-side validation)

`ChvSandbox.reset()` now drives the full reset cycle:

1. **Snapshot revert** via `ch-remote --api-socket <path> snapshot
fs://<snapshotPath>` followed by `ch-remote --api-socket <path>
resume`. Both calls go through `ChRemote` (`src/chv/chv-remote.ts`)
   which centralises argv shape and accepts an injectable `ExecFileFn`
   for tests.
2. **3-source verification** (per threat-model §5.1):
   - **fs_hash** — SHA-256 streamed over `rootfs.path` (the CoW overlay).
     Compared against `baselines.fs_hash`.
   - **open_fd_count** — `VsockClient.guestQuery("OpenFdCount")` over the
     established vsock RPC channel. Compared against
     `baselines.open_fd_count`.
   - **vmm_api_state** — `ch-remote info` parsed for `state`, normalised
     onto the protocol's canonical vocabulary
     (`running` | `paused` | `stopped` | `error`). Compared against
     `baselines.expected_vmm_api_state`.
3. **Divergence handling.** If any single source disagrees with its
   baseline, `reset()` throws `SandboxResetDivergenceError`, the sandbox
   transitions to `state() === "failed"`, and the returned
   `verification_details.divergence_action` is `"halt"`. This is
   unconditional — we deliberately do NOT require a quorum, because the
   substrate-lying threat model assumes an attacker can compromise up to
   2 of 3 sources (threat-model §A6).
4. **Baselines unset = scaffold mode.** If `config.baselines` is
   undefined, each source emits an explicit "not-configured" marker
   (`sha256:not-configured` for `fs_hash`, `0` for `open_fd_count`, the
   live VMM state for `vmm_api_state`). The reset soft-passes; the
   markers tell consumers (and the audit log) that real verification is
   not yet wired. Production endpoints MUST configure baselines.

### What still requires real-CHV validation on node-2

This is **host-side code**. The unit tests pin the `ch-remote` argv
shape and the divergence semantics against an injected `ExecFileFn` /
`HashFileFn` / fake vsock. They DO NOT exercise:

- Actual `ch-remote snapshot fs://...` semantics. CHV's documented verb
  for revert is sometimes documented as `restore`; this implementation
  uses `snapshot` per the P3.2a wire-protocol spec. If real CHV expects
  a different verb, the integration runner will surface a non-zero exit
  and we patch the verb in `chv-remote.ts` (one-line edit, obvious test
  diff).
- Actual rootfs CoW overlay file location and stability. We hash
  whatever `rootfs.path` points to; whether that file settles to a
  deterministic state after revert is for the runner to confirm.
- The install-time **golden-snapshot creation flow**. P3.2a's reset path
  consumes a snapshot that someone else creates. The matching install
  flow (separate work item) needs to:
  1. Boot the sandbox to a known-clean state.
  2. Pause the VMM (`ch-remote pause`).
  3. Create the snapshot (`ch-remote snapshot
destination_url=file://<dir>`).
  4. Compute the post-pause baselines: SHA-256 of the rootfs file,
     `OpenFdCount` over vsock, `vmm_api_state` from `ch-remote info`.
  5. Persist baselines to the endpoint config so reset can compare.

### Honest gaps that block "real production reset"

1. **Install-time golden-snapshot flow.** Not in this package; needs to
   be wired before reset's `snapshotPath` mode is meaningful. Until
   then, `snapshotPath` unset = no-op revert (verification still runs).
2. **Rootfs-overlay path semantics.** `RootfsConfig.path` is treated as
   the file to hash. For CHV's CoW mode, the path that's mutated is the
   overlay file, which may differ from the read-only base disk. The
   integration runner must point `rootfs.path` at the overlay file, not
   the base.
3. **`OpenFdCount` GuestQuery handler.** Implemented in `VsockClient`;
   the in-guest dispatcher (P3.4 image-builder) must respond. First-light
   confirmed echo dispatch but did not yet exercise GuestQuery.
4. **Baseline-recording flow.** `ChvSandboxConfig.baselines` is a config
   shape; how those values get computed and persisted at install time
   is a separate work item.
5. **Bootstrap kernel + rootfs**
   This package consumes `KernelConfig.path` and `RootfsConfig.path` as
   opaque strings. P3.4 produces both.

## What's needed from `brainstormVM`

P3.1a's hard sequencing gate is "brainstormVM `vm.boot` proven E2E on bare
metal" (plan §5, R17). Beyond that gate, this package needs the following
from the brainstormVM workstream:

- **Kernel image baseline.** Whether to bundle our own `vmlinux` or consume
  a brainstormVM-blessed one. Either way, we need its path on the runner
  and ideally its expected hash (so the install-time baseline machinery
  has something to record). _Open._
- **Disk format / layout convention.** brainstormVM uses per-VM disks
  (per the v3.2 plan note, D35); we need to know whether those disks are
  raw or qcow2 so `--disk path=...` flags use the right form. _Open._
- **Snapshot directory layout.** Cloud Hypervisor's `restore` flag takes
  a `source_url=file://<dir>` pointing at a directory containing a
  `state.json` + `mem.bin` + per-disk snapshot files. brainstormVM may
  already have an opinion here; if not, we set it in P3.2a. _Open._
- **VMM API state vocabulary.** This package maps `ch-remote info`'s
  `state` field to the protocol's `VmmApiState` (`running` / `stopped` /
  `paused` / `error`). brainstormVM's existing `vm.info` likely uses
  similar names — we should align. _Open._

## What's needed from P3.4 (image-build pipeline)

- A reproducible Linux microVM rootfs containing the MVP tool set
  (`echo`, `whoami`, `uname`, `cat-file`, plus 2–3 MSP-relevant tools).
- The in-guest dispatcher: a tiny program listening on the vsock port
  that accepts JSON-line requests, forks the requested tool, returns
  `{ exit_code, stdout, stderr, evidence_hash }`. The wire format
  proposed in `vsock-client.ts` is the contract — needs P3.3 alignment
  with crd4sdom's Go agent before it's frozen.
- The install-time baseline-recording flow that produces
  `ChvSandboxConfig.baselines` (`fs_hash`, `open_fd_count`,
  `expected_vmm_api_state`).

## Linux runner first-light checklist

When this scaffolding lands on a real Linux box (Hetzner runner per
0bz7aztr's pattern), the following sequence brings first light:

1. **Verify substrate.** Confirm `cloud-hypervisor --version` and
   `ch-remote --version` are present on `$PATH`. KVM available
   (`ls /dev/kvm`).
2. **Confirm `isChvSupportedHost()` returns true.** It should — sanity
   check.
3. **Stand up kernel + rootfs paths.** Either consume brainstormVM
   artifacts or use a plain Debian cloud kernel + minimal rootfs to
   prove boot, before P3.4 lands the real image.
4. **Implement the vsock RPC.**
   - Replace the throw at the bottom of `VsockClient.open()` with a real
     `CONNECT <guestPort>\n` write + `OK <port>\n` read.
   - Replace `VsockClient.sendCommand()` body with a real JSON-line
     write + read loop, deadline-bounded by `setTimeout`.
   - Build the in-guest dispatcher matching the wire format.
5. **Boot the VM.**
   - Construct a `ChvSandbox` with kernel/rootfs/vsock config.
   - Call `boot()`. It should resolve without throwing.
   - Confirm `state()` returns `"ready"`.
6. **Run a no-op tool.**
   - Call `executeTool({ tool: "echo", params: { message: "hello" }, command_id: "...", deadline_ms: 5000 })`.
   - Verify `exit_code === 0`, `stdout` contains "hello".
7. **Wire FS-hash + open-fd sources for `verifyPostReset`.**
   - Replace the "return baseline" stubs with a real overlay hash and a
     real in-guest fd-count query.
8. **Snapshot + revert smoke.**
   - Take a snapshot via `ch-remote snapshot destination_url=file://...`.
   - Run a tool that mutates state.
   - Call `reset()`. Confirm:
     - `verification_passed: true`
     - `verification_details.fs_hash_match: true`
     - `verification_details.divergence_action: "none"`
   - Re-run the no-op tool to confirm sandbox is still functional.
9. **Negative reset test.**
   - After reset, mutate the host-visible overlay file directly.
   - Call `reset()` again — verification should now FAIL with
     `SandboxResetDivergenceError`. This proves the integrity monitor
     catches at least one of the substrate-lying patterns from threat
     model §A6.
10. **Hand off to P3.2a (Linux reset machinery).** Reset latency
    measurement (1000 iterations, p50 < 500 ms target) and
    failure-mode catalog.

## Build / typecheck

```bash
npx turbo run build --filter='@brainst0rm/sandbox'
npx turbo run typecheck --filter='@brainst0rm/sandbox'
```

The build was confirmed green on Darwin during scaffolding. There are no
tests in this package yet — meaningful tests require a Linux runner. The
type contract is the binding artifact today; tests follow first light.

## Relationship to the rest of Phase 3

- **P3.1b (macOS / Apple Virtualization.framework)** — separate package.
  Implements the same `Sandbox` interface from `src/sandbox.ts` so the
  dispatcher remains backend-agnostic. Currently TBD on naming
  (`@brainst0rm/sandbox-vf`?). The `SandboxBackend` union here already
  reserves `"vf"`.
- **P3.3 (Go integration)** — crd4sdom's work mirrors this interface in
  Go. The TypeScript `ChvSandbox` is the reference for behaviour, not
  the production runtime — the Go agent will own the in-process path on
  Linux endpoints. This package may also be wired into
  `@brainst0rm/endpoint-stub` as an optional executor for end-to-end
  TypeScript-only loops during dev.
- **P3.4 (image build)** — produces the kernel + rootfs + in-guest
  dispatcher this package consumes opaquely.
- **P3.5a (Linux validation)** — runs the 1000-dispatch red-team
  against a fully wired-up `ChvSandbox`.
