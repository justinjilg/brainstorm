# `bsm-vz-helper` — Swift helper for `@brainst0rm/sandbox-vz`

This is the Swift binary that owns Apple's Virtualization.framework on
behalf of the TypeScript `VzSandbox` (in `../src/vz-sandbox.ts`). The
TypeScript side spawns this binary and speaks to it over NDJSON on
stdio. The wire contract lives in `../src/helper-protocol.ts` — that
file is the source of truth; this Swift target conforms to it.

## Status

- **Compiles** with Swift 5.9+ on macOS 11+ (Apple Silicon target).
- **Unit tests pass** against an injected `FakeVMHost` (no real VM).
- **Has not booted a real Linux guest.** That requires a code-signed
  binary with the `com.apple.security.virtualization` entitlement,
  plus a Linux kernel `Image` and a rootfs disk image. See "First-boot
  hand-off note" at the bottom.

## Layout

```
helper/
  Package.swift                   # SwiftPM manifest, swift-tools-version:5.9
  entitlements.plist              # com.apple.security.virtualization
  Sources/bsm-vz-helper/
    main.swift                    # argv dispatch
    Protocol.swift                # NDJSON wire types (mirror of helper-protocol.ts)
    Preflight.swift               # `preflight` subcommand
    VMHost.swift                  # VZVirtualMachine wrapper
    NDJSONLoop.swift              # stdin -> dispatcher -> stdout
  Tests/bsm-vz-helperTests/
    NDJSONLoopTests.swift         # FakeVMHost-driven request/response tests
```

## Build

```bash
cd packages/sandbox-vz/helper
swift build -c release
```

The resulting binary is at `.build/release/bsm-vz-helper`.

## Ad-hoc codesign for local development

Apple Virtualization.framework refuses to start a VM unless the
calling binary carries the `com.apple.security.virtualization`
entitlement, which in turn requires a code signature. For local
development on a single Mac that signature can be ad-hoc (`--sign -`):

```bash
codesign \
  --sign - \
  --entitlements entitlements.plist \
  --force \
  --options runtime \
  .build/release/bsm-vz-helper
```

Verify:

```bash
codesign -d --entitlements - .build/release/bsm-vz-helper
# Should print:
#   [Dict]
#       [Key] com.apple.security.virtualization
#       [Value]
#           [Bool] true
```

### Why ad-hoc only works locally

Ad-hoc signing puts a signature on the binary but does **not** chain
to any Apple-recognized certificate authority. It works because:

1. macOS will load and run an ad-hoc-signed binary on the same machine
   that produced the signature (or any machine that explicitly trusts
   it via Gatekeeper override).
2. The kernel's entitlement check is satisfied because the signature,
   though self-issued, is present.

It does **not** work on customer machines because:

1. Gatekeeper rejects ad-hoc-signed binaries downloaded from the
   internet (quarantined by `com.apple.quarantine` xattr).
2. There is no notarization receipt — Apple's notary service will not
   sign anything that lacks a valid Developer ID.
3. The entitlement itself is not "restricted" the way (e.g.)
   `com.apple.security.cs.disable-library-validation` is, but the
   binary distribution chain requires Developer ID + notarization to
   be trusted past the first-launch gate.

For production distribution we need:

1. Apple Developer Program enrollment (one-time, ~$99/year).
2. A `Developer ID Application` certificate.
3. A `.app` bundle containing the helper.
4. `codesign` with the Developer ID + `--options runtime` (hardened
   runtime).
5. `notarytool submit` + `notarytool wait` + `stapler staple`.

This is explicitly **deferred to v1.0** per D24 in
`docs/endpoint-agent-plan.md`. The current scope is "compile-clean +
unit-testable on a single dev Mac."

## Subcommand surface

Mirrors `../src/helper-protocol.ts`:

```
bsm-vz-helper preflight
bsm-vz-helper boot --kernel PATH --rootfs PATH [--initrd PATH]
                   [--cmdline STR] [--cpus N] [--memory-mib N]
                   [--saved-state PATH]
bsm-vz-helper exec        # NOT IMPLEMENTED — use NDJSON-over-stdio in boot mode
bsm-vz-helper save-state  # NOT IMPLEMENTED — use NDJSON-over-stdio in boot mode
bsm-vz-helper restore-state
                          # NOT IMPLEMENTED — use NDJSON-over-stdio in boot mode
```

The `exec` / `save-state` / `restore-state` shell-form subcommands are
forwarders to a running helper via a UNIX socket at
`$XDG_RUNTIME_DIR/bsm-vz-helper.sock`. That UNIX-socket bridge is
deferred — the production hot path is `VzSandbox` (TypeScript)
spawning the helper in `boot` mode and sending NDJSON on stdio. The
shell forwarders exit with `HELPER_EXIT_INTERNAL_BUG` if invoked, so
ops tooling can detect the gap deterministically.

## Exit codes

These MUST match `HELPER_EXIT_*` constants in
`../src/helper-protocol.ts`:

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | success                                                         |
| 64   | preflight failed (entitlement / unsupported macOS / arch)       |
| 65   | boot config invalid (bad kernel path, missing flag, etc.)       |
| 66   | VM lifecycle error (start / stop / hypervisor refused)          |
| 67   | guest unreachable on vsock                                      |
| 68   | reset verification divergence (`RESET_VERIFICATION_DIVERGENCE`) |
| 69   | operation timed out                                             |
| 70   | internal helper bug                                             |

## Running the unit tests

```bash
cd packages/sandbox-vz/helper
swift test
```

These tests use an injected `FakeVMHost` and exercise:

- `exec` request/response round-trip preserves `request_id`
- `reset` returns the full verification-fields shape
- `save_state` / `restore_state` round-trip
- `verify` echoes baselines back faithfully
- `shutdown` terminates the loop with exit code 0
- Garbage NDJSON emits a `helper_panic` event without crashing
- Encoded responses are valid single-line JSON with the expected
  `kind` field
- `preflight` produces the correct shape on the host arch / OS

The tests do NOT require Virtualization.framework to be loadable —
they exercise the protocol layer only.

## Honesty about what's untested

- **No real VM has booted via this helper.** Without an Apple
  Developer cert + a Linux kernel `Image` + rootfs we can compile and
  unit-test the protocol layer, but
  `VZVirtualMachine.start(completionHandler:)` returns
  `VZErrorVirtualMachineDeniedEntitlement` if the binary is not signed
  with `com.apple.security.virtualization`.
- **The `exec` handler is stubbed.** It returns a well-formed
  `exec_response` envelope so the TS-side `VzSandbox` unit tests pass,
  but no work is dispatched to a guest. Replacing this stub is the
  load-bearing first step for first-boot.
- **The `verify` handler trusts agent-supplied baselines.** A real
  implementation needs three independent signal sources from inside
  the guest (FS hash, open-fd count, VMM API state), per
  `docs/endpoint-agent-threat-model.md` §5. Without a guest dispatcher
  on the wire we cannot produce them.
- **vsock CID introspection is hard-coded to `3`.** Apple's API does
  not expose CID directly; the proper path involves
  `VZVirtioSocketDevice.connect(toPort:completionHandler:)` and
  reading the resulting connection's source CID. Stubbed for now.

---

## First-boot hand-off note

For Justin (or a future implementer) with a signed Developer ID
cert and a Linux microVM image, the **minimum viable next step**
to actually boot a Linux guest is:

1. **Sign the helper.** Either ad-hoc for a single dev box:

   ```bash
   codesign --sign - --entitlements entitlements.plist --force \
     .build/release/bsm-vz-helper
   ```

   …or with Developer ID for distribution. Confirm with
   `codesign -d --entitlements - .build/release/bsm-vz-helper`.

2. **Get a Linux kernel `Image` and rootfs.** The microVM image
   pipeline is owned by P3.4 (orchestrator + crd4sdom). For a
   one-off smoke test you can use Apple's
   [`SimpleVM` sample's debian image-builder](https://developer.apple.com/documentation/virtualization/running_linux_in_a_virtual_machine)
   adapted for ARM64. Either way you need an unstripped ARM64
   `Image` (not `bzImage`) and a raw rootfs disk.

3. **Run `preflight` first.** Confirms entitlement is present and
   `fast_snapshot_supported` reflects your macOS version:

   ```bash
   .build/release/bsm-vz-helper preflight
   ```

4. **Boot via NDJSON-over-stdio.** Spawn the helper as a child of a
   Node test script (mirroring how `VzSandbox` does it):

   ```bash
   .build/release/bsm-vz-helper boot \
     --kernel /path/to/Image \
     --rootfs /path/to/rootfs.img \
     --cmdline "console=hvc0 root=/dev/vda rw"
   ```

   Watch stdout for the `boot_result` line. If `ok:true`, the VM is
   running and you can pipe NDJSON requests in.

5. **Replace the `handleExec` stub with real vsock dispatch.** The
   protocol is in `docs/endpoint-agent-protocol-v1.md` §6. Use
   `VZVirtioSocketDevice.connect(toPort:1024)` to dial the guest
   dispatcher, send a `ToolDispatch` frame, then drain `ToolResult`
   - `EvidenceChunk` frames per the hash-chain rules.

6. **Replace the `handleVerify` stub with real GuestQuery
   round-trips.** Same vsock device, but on port 1026 (per
   `../README.md` §vsock-equivalent). Returns
   `OpenFdCount`, `MemUsage`, `ProcessList` results.

After step 6, the helper is enough for P3.5b validation gates
(1000-dispatch red-team, sandbox escape probe, network egress
audit, reset verification injection).

The scope-control answer to "should this be one PR or six?" — six.
Step 1 is a packaging task. Steps 2 and 3 are validation, not
implementation. Steps 4 through 6 are independently testable. Don't
let the load-bearing real-vsock work hide behind a "first boot" PR.
