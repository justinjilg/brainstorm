# sandbox first-light + reset-cycle scripts

Smoke-test scripts for proving an end-to-end CHV boot + dispatch on a real
Linux KVM host, plus the install-time golden-snapshot CLI and the
reset-cycle integration test that exercises P3.2a's substrate-lying
defense end-to-end.

## Files

- `first-light.sh` — full driver (host sanity → build → image-builder → boot
  - echo dispatch → captured log + summary). Run from monorepo root.
- `first-light.ts` — Node script that constructs a `ChvSandbox` against a
  pre-built kernel + rootfs, calls `boot()`, runs an `echo` tool through
  the vsock dispatch path, and exits 0/1/2/3 based on outcome.
- `snapshot-create.ts` — install-time CLI. Boots cold, pauses VMM, takes
  a CHV snapshot, computes the three baselines (fs_hash / open_fd_count
  / expected_vmm_api_state), emits a JSON config block to stdout. Exit
  codes 0/1/2/3/4 (see header for the mapping).
- `reset-cycle.sh` — P3.2a integration validator. Mints a golden via
  `snapshot-create.js`, drives a clean reset, tampers the overlay,
  drives a second reset, and asserts the second one throws
  `SandboxResetDivergenceError`. Called by `full-validation.sh` step 7.

## Usage

### Full driver (recommended)

From a clean Linux x86_64 host with KVM:

```bash
# Install prereqs (Ubuntu 24.04):
#   cloud-hypervisor + ch-remote (release tarball or distro pkg)
#   nodejs >=22 (NodeSource)
#   docker (for image-builder)
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
git checkout feat/sandbox-phase-3-scaffold

bash packages/sandbox/scripts/first-light.sh
```

Exit codes:

- `0` — boot reached `state="ready"` AND echo dispatch returned `exit_code=0`
- `1` — boot failed (CHV crash, vsock handshake timeout, etc.)
- `2` — boot OK, executeTool failed
- `3` — host sanity / config error
- `4` — TS build or image-builder failed

Logs land in `${FIRSTLIGHT_DIR:-/var/lib/firstlight}/first-light-<timestamp>.log`.

### Just the Node script

If you want to bring your own kernel + rootfs and skip the image-builder step:

```bash
npx turbo run build --filter='@brainst0rm/sandbox'

export BSM_KERNEL=/path/to/bsm-sandbox-kernel
export BSM_ROOTFS=/path/to/bsm-sandbox-rootfs.img
export BSM_VSOCK_SOCKET=/tmp/bsm-vsock.sock
export BSM_API_SOCKET=/tmp/bsm-api.sock
export BSM_GUEST_PORT=52000   # image-builder's vsock-init default

node packages/sandbox/dist/scripts/first-light.js
```

### Install-time golden-snapshot flow

The runtime reset path (`ChvSandbox.reset()`) requires
`config.snapshotPath` AND a fully-populated `config.baselines` block, or
`verifyPostReset()` deliberately throws `SandboxResetDivergenceError`
(threat-model §A6 substrate-lying defense, by design). The
`snapshot-create.ts` CLI mints both.

Run it once per (kernel + rootfs + image-builder version) tuple. Re-run
after any image-builder rebuild that changes the rootfs payload.

```bash
# Build first (produces dist/scripts/snapshot-create.js):
npx turbo run build --filter='@brainst0rm/sandbox'

# Inputs:
export BSM_KERNEL=/path/to/bsm-sandbox-kernel
export BSM_INITRAMFS=/path/to/bsm-sandbox-initramfs   # optional but typical
export BSM_ROOTFS=/path/to/bsm-sandbox-rootfs.img
export BSM_OVERLAY=/var/lib/bsm/overlay.img           # CoW destination
export BSM_SNAPSHOT_DIR=/var/lib/bsm/golden           # snapshot files land here
export BSM_VSOCK_SOCKET=/tmp/bsm-snapshot.sock        # default
export BSM_API_SOCKET=/tmp/bsm-snapshot-api.sock      # default
export BSM_GUEST_PORT=52000                           # image-builder default

# Run — JSON to stdout, progress to stderr:
node packages/sandbox/dist/scripts/snapshot-create.js \
    --output=/var/lib/bsm/golden-baselines.json
```

Output (stdout, also written to `--output` if provided):

```json
{
  "snapshotPath": "/var/lib/bsm/golden",
  "rootfs": {
    "path": "/path/to/bsm-sandbox-rootfs.img",
    "overlayPath": "/var/lib/bsm/overlay.img"
  },
  "baselines": {
    "fs_hash": "sha256:...",
    "open_fd_count": 3,
    "expected_vmm_api_state": "running"
  }
}
```

Paste the three top-level keys (`snapshotPath`, `rootfs`, `baselines`)
into your `ChvSandboxConfig`. The runtime reset path will then:

1. `restore source_url=file://<snapshotPath>` + `resume`
2. Hash `rootfs.overlayPath` and compare to `baselines.fs_hash`
3. `GuestQuery OpenFdCount` and compare to `baselines.open_fd_count`
4. `ch-remote info` and compare to `baselines.expected_vmm_api_state`

Any disagreement produces `divergence_action="halt"` and
`reset()` throws `SandboxResetDivergenceError`.

Exit codes:

- `0` — snapshot + baselines emitted successfully
- `1` — boot failed
- `2` — pause / snapshot / resume failed
- `3` — env / usage error (missing required env, missing files)
- `4` — baseline computation failed (overlay hash, fd query, info parse)

### Reset-cycle integration test

`reset-cycle.sh` is the end-to-end gate that proves the substrate-lying
defense actually fires. Pipeline:

1. Build sandbox + image artifacts (re-uses image-builder cache)
2. Run `snapshot-create.js` → mints `${RESET_CYCLE_DIR}/golden-<ts>/`
   and a baseline JSON file
3. Boot a fresh `ChvSandbox` configured from that JSON
4. Run an echo dispatch (proves the vsock channel)
5. `reset()` → expect `divergence_action="none"` (overlay unchanged)
6. **Tamper**: append a sentinel string to `BSM_OVERLAY` via
   `appendFileSync` (any byte change breaks the SHA-256 hash)
7. `reset()` → MUST throw `SandboxResetDivergenceError`
8. PASS if step 7 throws the right error class; FAIL otherwise

Run from monorepo root:

```bash
bash packages/sandbox/scripts/reset-cycle.sh
```

Logs land in `${RESET_CYCLE_DIR:-/var/lib/firstlight}/reset-cycle-<ts>.log`.

Exit codes:

- `0` — defense fired correctly (PASS)
- `1` — defense compromised, setup failure, or unexpected error class
- `3` — host sanity failure
- `4` — sandbox build / image artifacts missing

`full-validation.sh` step 7 auto-detects this script and runs it; absent
the script, step 7 prints "skipped" with a clear reason. Once this
script is on disk, the auto-skip flips to "run".

## What this proves

- `cloud-hypervisor` is callable + can boot a Linux guest from the
  image-builder's kernel + rootfs
- The CHV `--vsock cid=N,socket=/path` device works end-to-end
- The host's `VsockClient` CONNECT handshake matches CHV's bridge protocol
- The in-guest `vsock-init` (PID 1, length-prefixed JSON over vsock)
  receives a `ToolDispatch`, exec's `echo`, returns a `ToolResult` with
  matching `command_id`
- The 30s partial-frame timeout doesn't trip on a healthy peer

## What this does NOT prove

- Snapshot/revert reset machinery (P3.2a — not yet wired)
- 3-source verification with real baselines (`fs_hash`, `open_fd_count`,
  `vmm_api_state`) — `verifyPostReset` returns sentinel zeros until P3.2a
- Resistance to the substrate-lying attacker (P3.5 / P-A6 — currently
  mock-only)
- Multi-sandbox-per-host isolation (post-MVP)

## Image-builder notes

The image-builder default port for `vsock-init` is **52000**, set via the
constant `defaultVsockPort` in `packages/image-builder/vsock-init/main.go`.
The `BSM_VSOCK_PORT` env var on the kernel cmdline can override it. The
host-side `VsockClient` defaults to port 1024 (per protocol §6 canonical
table); the first-light script overrides to 52000 to match image-builder.

If you re-build vsock-init with a different default, pass the matching port
via `BSM_GUEST_PORT`.
