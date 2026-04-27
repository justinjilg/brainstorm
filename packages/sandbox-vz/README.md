# @brainst0rm/sandbox-vz

macOS Apple Virtualization.framework (VZ) backend for the Brainstorm
endpoint-agent sandbox abstraction (P3.1b in `docs/endpoint-agent-plan.md`).

This is the **developer-laptop tier** of the sandbox. Production Linux
endpoints use Cloud Hypervisor via `@brainst0rm/sandbox` (P3.1a). Both
backends run the **same Linux microVM image** behind a unified `Sandbox`
interface so guest-side tools, evidence-hashing, and reset semantics are
backend-agnostic.

> **Status:** scaffolding only. Compiles. Unit-tested with an injected
> fake helper. **Not booted against a real VM** — that requires the
> Swift `bsm-vz-helper` binary, which is a separate deliverable
> (see "What needs to happen for first-boot" below). Be honest with
> downstream consumers: this package is a wire-spec + compile-clean
> scaffold, not a working microVM yet.

---

## Architecture

```
   ┌────────────────────────┐
   │  brainstorm-agent (TS) │
   │                        │
   │  VzSandbox             │   NDJSON over stdio (this package)
   │   (this package)       │ ──────────────────────────────┐
   └────────────────────────┘                               │
                                                            ▼
                                           ┌─────────────────────────────┐
                                           │  bsm-vz-helper (Swift)      │
                                           │   - VZVirtualMachine        │
                                           │   - VZVirtioSocketDevice    │
                                           │   - lives in code-signed    │
                                           │     .app bundle             │
                                           └──────────────┬──────────────┘
                                                          │ Virtualization.framework
                                                          ▼
                                           ┌─────────────────────────────┐
                                           │  Linux microVM (guest)      │
                                           │   - same image as CHV       │
                                           │   - vsock dispatcher        │
                                           └─────────────────────────────┘
```

Why a Swift helper at all (vs. a CGo bridge or a third-party Node binding)?

1. Virtualization.framework is Obj-C / Swift only. A small first-party
   Swift binary is the lowest-risk integration.
2. The framework requires an entitlement that **must be embedded in a
   code-signed app bundle**. Isolating that to one ~300-line Swift
   binary keeps the entitlement scope minimal — the agent itself can
   ship as a normal CLI, and only the helper goes through bundling +
   signing.
3. R13 in the plan: `Code-Hex/vz` Go bindings flagged as "maturity
   check needed". A purpose-built Swift binary owned by us avoids that
   risk vector entirely.

---

## Apple VZ requirements

### Entitlements

The helper's `.app` bundle MUST carry the
`com.apple.security.virtualization` entitlement:

```xml
<!-- bsm-vz-helper.entitlements -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.virtualization</key>
    <true/>
  </dict>
</plist>
```

Without this entitlement, calling `VZVirtualMachine.start()` fails with
`VZErrorVirtualMachineDeniedEntitlement`. **There is no way around this
short of running the helper from inside a properly-signed app bundle.**
For local dev on Justin's laptop, ad-hoc signing (`codesign --sign -`)
is sufficient; production / customer endpoints need a Developer ID
signature + notarization, both of which are explicitly DEFERRED to v1.0
per the plan (D24).

### Code signing

For local dev (this is what the orchestrator can actually verify works
on a Mac):

```bash
swift build -c release
codesign --sign - \
  --entitlements bsm-vz-helper.entitlements \
  --force \
  .build/release/bsm-vz-helper
```

For production: the helper will live at
`brainstorm-agent.app/Contents/MacOS/bsm-vz-helper`, signed with the
Brainstorm Apple Developer ID, hardened-runtime enabled, notarized via
`notarytool`. The agent process resolves the helper path by looking
inside its own bundle when packaged. **Notarization needs Apple
Developer Program enrollment, which is not done yet** (post-MVP per
D24).

### macOS version matrix

| macOS version | Reset path                                                   | Latency target |
| ------------- | ------------------------------------------------------------ | -------------- |
| 14 Sonoma+    | `VZVirtualMachine.saveMachineStateTo:` /\* fast snapshot \*/ | < 1s p50       |
| 11–13         | Cold boot fallback (full kernel reboot)                      | < 5s p50       |
| < 11          | UNSUPPORTED                                                  | —              |

This matches D23 in the plan. The helper auto-detects host version on
`bsm-vz-helper preflight` and reports `fast_snapshot_supported: bool`.

### Apple Silicon vs Intel

- Apple Silicon (M-series) is the **target host arch**. Linux guest
  must be ARM64; we ship a single ARM64 microVM image.
- Intel Macs: Virtualization.framework on Intel is supported up to
  macOS 13 only (Apple deprecated it for macOS 14+). Out of MVP scope.
  The helper's `preflight` rejects `arm64=false && macos>=14`.

### vsock-equivalent

VZ does not expose vsock by that name — the equivalent is
`VZVirtioSocketDevice` (a virtio-socket-over-VZ implementation). From
the guest's perspective it IS Linux vsock — same ioctls, same syscalls.
From the host's perspective the helper attaches a
`VZVirtioSocketDevice` to the VM config, then connects with
`VZVirtioSocketConnection`s for each port the guest dispatcher listens
on.

The CID assignment is host-side: the helper picks a CID and reports it
back in the boot result so the TS side can audit/log. Guest-side
ports follow the same convention as the CHV backend
(`@brainst0rm/sandbox`) — coordinate with the Linux track when both
land. Default ports per the threat-model integrity-monitor design:

- `:1024` — `ToolDispatch` ↔ `ToolResult` channel
- `:1025` — `EvidenceChunk` stream
- `:1026` — `GuestQuery` ↔ `GuestResponse` (integrity verification —
  open-fd count, mem usage, process list)
- `:1027` — control / heartbeat

### Kernel format

VZ requires a **bootable Linux kernel image** for Linux guests; there
is no firmware or BIOS path (you can't just point it at a disk image
and expect a multiboot loader to figure it out). Concretely:

- ARM64: `Image` (the unstripped kernel image, same one Linux uses for
  EFI boot). NOT a `bzImage`.
- An optional initrd/initramfs.
- A kernel command line you supply (the helper doesn't synthesize one
  — defaults are in `VzBootConfig.cmdline`).

The microVM image build pipeline (P3.4) produces the `Image` artifact
alongside the rootfs. This package only consumes paths.

---

## What the helper does (Swift, NOT in this PR)

Defined in `src/helper-protocol.ts` as a strict NDJSON contract.
Subcommand surface:

```
bsm-vz-helper preflight
bsm-vz-helper boot --kernel ... --rootfs ... [--initrd ...] [--cmdline ...]
                   [--cpus N] [--memory-mib N] [--saved-state ...]
bsm-vz-helper exec --command-id ... --tool ... --params ... --deadline-ms ...
bsm-vz-helper save-state --out PATH      # macOS 14+ only
bsm-vz-helper restore-state --from PATH  # macOS 14+ only
```

When invoked as `boot`, the helper daemonizes and switches into NDJSON
mode on stdin/stdout. See `src/helper-protocol.ts` for the request /
response shapes and exit codes.

---

## What needs to happen for first-boot on a real macOS dev laptop

1. **Write `bsm-vz-helper` (Swift).** ~300 lines wrapping
   `VZVirtualMachineConfiguration`,
   `VZLinuxBootLoader`,
   `VZVirtioBlockDeviceConfiguration`,
   `VZVirtioSocketDeviceConfiguration`,
   `VZVirtualMachine`, plus an NDJSON loop on stdin. Implements every
   subcommand in `helper-protocol.ts`.
2. **Build a code-signed `.app` bundle.** Minimal Info.plist + the
   helper binary + the entitlements file above. `codesign --sign -`
   for local dev; deferred to v1.0 for notarized distribution.
3. **Build the Linux microVM image.** ARM64 `Image` kernel + rootfs
   with the guest dispatcher baked in. Owned by P3.4 (orchestrator +
   crd4sdom shared work) — coordinate to ensure the same image runs
   under both VZ and CHV.
4. **Wire VzSandbox into brainstorm-agent.** When the parallel
   `@brainst0rm/sandbox` package merges, refactor `VzSandbox` to
   `implements Sandbox` from that package and drop the local
   `Sandbox` interface in `src/types.ts`.
5. **Run `bsm-vz-helper preflight` from VzSandbox at agent startup.**
   Surface failures with actionable error codes (entitlement missing
   = HELPER_EXIT_PREFLIGHT_FAIL).
6. **Validate end-to-end.** P3.5b validation gates: 1000-dispatch
   red-team, sandbox escape probe, network egress audit, reset
   verification injection. Owner: orchestrator, crd4sdom PR review.

The TypeScript side of this list is entirely items 4 and 5; everything
else is the Swift / image-build / packaging story that this package
deliberately does not own.

---

## Honesty about what's untested

- **No real VM has booted via this package.** Unit tests inject a fake
  ChildProcess and play canned NDJSON responses. The wire shape is
  correct; the Swift binary is the missing piece.
- **No entitlement / signing has been verified.** All of §"Code
  signing" above is design-time documentation, not a tested workflow.
- **No reset verification semantics have been exercised under attack.**
  Per threat-model §3 (substrate-lying attacker class), the 3-source
  cross-check is the load-bearing defense; we surface the data shape
  the helper reports but do not adversarially probe it. P3.5b owns
  that.
- **The local `Sandbox` interface in `src/types.ts` will be replaced**
  with the canonical one from `@brainst0rm/sandbox` after that
  parallel package lands. The shapes are byte-equivalent on purpose
  to make the swap mechanical.

---

## Tests

```bash
npm test --workspace @brainst0rm/sandbox-vz
```

The suite fakes the helper process and exercises:

- Boot handshake (waits for `boot_result` line).
- `executeTool` request/response correlation by `request_id`.
- `reset` returns a `SandboxResetState` whose `verification_details`
  matches the `@brainst0rm/relay` wire shape.

Cross-platform: tests are skipped on non-Darwin since `boot()` rejects
early — they are safe to run in CI on Linux without false failures.

---

## See also

- `docs/endpoint-agent-plan.md` §5 — Phase 3 sandbox plan, P3.1b row
- `docs/endpoint-agent-protocol-v1.md` §13 — wire schemas
  (`SandboxResetState`, `VerificationDetails`, `VmmApiState`)
- `docs/endpoint-agent-threat-model.md` §5 — 3-source reset
  verification (substrate-lying attacker class)
- `packages/sandbox/` — sibling Cloud Hypervisor backend (parallel
  P3.1a track; this package will eventually consume its `Sandbox`
  interface)
- `packages/relay/src/types.ts` — canonical wire types
