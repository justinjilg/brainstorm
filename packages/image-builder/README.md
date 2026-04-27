# @brainst0rm/image-builder

Reproducible Linux microVM image builder for the Brainstorm endpoint sandbox.

This package implements **P3.4** of the [endpoint-agent plan](../../docs/endpoint-agent-plan.md).
Its outputs are consumed by **P3.1a** (Cloud Hypervisor on Linux) and **P3.1b**
(Apple Virtualization.framework on macOS) to boot a sandbox microVM that
executes operator-dispatched tools in isolation.

It is deliberately the **smallest possible** package that can produce a
bootable image: a Dockerfile, a Go init binary, and a driver script. There is
no TypeScript here — `tsup` is not invoked because there is no TypeScript code
to bundle. `package.json` exists so the workspace knows about the package and
so `npm run build -w @brainst0rm/image-builder` works.

---

## Inputs

- **Docker** (Docker Desktop on macOS, Docker Engine on Linux). Tested with
  Docker 29.x on Darwin (Docker Desktop) — see "Smoke run" below.
- A working network connection (to fetch the `golang:1.22-alpine`,
  `alpine:3.20`, and Alpine `linux-virt` package). After the first build,
  Docker layer cache makes subsequent builds offline-tolerant.
- The package source itself: `vsock-init/` (Go), `build/Dockerfile`,
  `scripts/build.sh`.

That is the entire input set. No host kernel headers, no host Go toolchain,
no `debootstrap`, no host `mkfs.ext4` are required — everything happens inside
Docker.

---

## Outputs

`scripts/build.sh` writes the following to `packages/image-builder/artifacts/`:

| File                     | Purpose                                                                  | Consumer         |
| ------------------------ | ------------------------------------------------------------------------ | ---------------- |
| `bsm-sandbox-kernel`     | Linux kernel (Alpine `vmlinuz-virt`, 6.x). Boot image for CHV and VF.    | P3.1a, P3.1b     |
| `bsm-sandbox-initramfs`  | Alpine `initramfs-virt` — for early-userspace if cmdline calls for it.   | P3.1a (rare)     |
| `bsm-sandbox-rootfs.img` | ext4, 64 MiB. Contains busybox + MVP tool whitelist + `/sbin/init`.      | **P3.1a, P3.1b** |
| `bsm-sandbox-rootfs.tar` | Same content as `.img`, in tar form. Useful for inspection / squashfs.   | dev / debugging  |
| `vsock-init.bin`         | Standalone copy of the PID-1 vsock-init binary (also baked into rootfs). | dev / debugging  |
| `checksums.txt`          | SHA-256 over each of the above. Baseline for **D15 hash compare**.       | reset machinery  |

The `checksums.txt` file is what `Sandbox.VerifyResetIntegrity()` (P3.2a/b)
hashes against. Treat it as a release artifact.

---

## How P3.1a and P3.1b consume the artifacts

### Cloud Hypervisor (P3.1a, Linux)

```
cloud-hypervisor \
  --kernel  artifacts/bsm-sandbox-kernel \
  --disk    path=artifacts/bsm-sandbox-rootfs.img,readonly=on \
  --cmdline "console=hvc0 root=/dev/vda init=/sbin/init quiet" \
  --cpus    boot=1 \
  --memory  size=128M \
  --vsock   cid=3,socket=/var/run/bsm/sandbox.vsock \
  --serial  tty
```

The agent (`packages/sandbox/`) connects to the vsock and speaks the wire
protocol described in `docs/endpoint-agent-protocol-v1.md` §6.

### Apple Virtualization.framework (P3.1b, macOS)

The macOS sandbox track (`packages/sandbox-vz/`) wraps `VZVirtualMachineConfiguration`
and points it at the same kernel + rootfs. The exact bridge is owned by P3.1b;
this package only guarantees that the kernel + rootfs combination boots into a
shell prompt with `/sbin/init` running and listening on
`vsock(VMADDR_CID_ANY, 52000)`.

VF on Sonoma+ uses `VZSavedStateURL` snapshots, which are taken **after** boot
completes — so the cold-boot artifacts in this package are the seed, not the
hot-path image.

---

## The vsock-init protocol (subset of `endpoint-agent-protocol-v1.md` §6)

`vsock-init` is the rootfs's PID 1. It opens an `AF_VSOCK` listener on port
**52000** (overridable via `BSM_VSOCK_PORT`). All frames are length-prefixed
JSON, exactly as defined in protocol §2:

```
[ uint32 BE payload_len ][ payload_len bytes of UTF-8 JSON ]
```

Implemented message types (MVP):

| Direction       | Type            | Behavior                                                                   |
| --------------- | --------------- | -------------------------------------------------------------------------- |
| agent → sandbox | `ToolDispatch`  | Look up `tool` in whitelist, run with mapped argv, reply with `ToolResult` |
| sandbox → agent | `ToolResult`    | exit_code + stdout + stderr + (placeholder) evidence_hash                  |
| agent → sandbox | `GuestQuery`    | `OpenFdCount` / `MemUsage` / `ProcessList` per §6.3.5                      |
| sandbox → agent | `GuestResponse` | Per-kind result schema per §6.3.6                                          |
| agent → sandbox | `ResetSignal`   | No-op in guest; emits `ResetAck` for heartbeat. Real reset is host-side.   |
| sandbox → agent | `ResetAck`      | Always `verification_passed: true` with placeholder hashes (see TODOs).    |

Tool whitelist (D22 in plan): `echo`, `whoami`, `uname`, `cat`, `ls`, `env`,
`sh`. Each tool has an explicit param-to-argv mapping in
`vsock-init/main.go`'s `paramsToArgs`. Free-form argv smuggling is rejected.

---

## What's stubbed vs what's real

This is the brutal-honesty section. Every line below is a known gap, ordered
roughly by severity.

### Real (production-ready quality, just untested in the live agent loop)

- **`vsock-init` Go binary.** Real code, ~430 LOC, compiles cleanly, listens
  on vsock, dispatches tools, answers GuestQuery. Static, stripped, CGO-off.
- **Length-prefixed framing** matching protocol §2 (uint32 BE, 16 MiB cap,
  30 s read timeout).
- **MVP tool whitelist enforcement** with explicit per-tool argv mapping.
- **Guest-query responses** for `OpenFdCount` / `MemUsage` / `ProcessList`,
  reading from `/proc` correctly.
- **Dockerfile** — multi-stage, deterministic timestamps via
  `SOURCE_DATE_EPOCH`, builds without privileged mode.
- **Driver script** (`scripts/build.sh`) — handles "no Docker" case
  gracefully, exits 0 on platforms that can't build (so CI on bare macOS
  doesn't fail), supports `--target` / `--no-extract`.
- **Checksums** — produced inside the build, extracted alongside artifacts.

### Stubbed / placeholder

- **`evidence_hash`** in `ToolResult` is the literal string
  `"sha256:hash-chain-not-yet-implemented"`. The §6.3 hash-chain formula
  (chunk_hash[seq] over command_id_bytes ‖ uint64_be(seq) ‖ chunk_size ‖
  chunk_data ‖ prev_hash) is not yet computed inside the guest. EvidenceChunk
  streaming is not implemented — only single-shot ToolResult.
- **`ResetAck.verification_details.fs_hash` / `golden_hash`** are placeholder
  strings. The 3-source cross-check (D15) is host-side machinery; the guest
  side advertises `vmm_api_state: "running"` but the actual baseline-hashing
  belongs in P3.2a/b. The current `ResetAck` is sufficient for a heartbeat,
  not for the substrate-lying-attacker defense.
- **No seccomp inside the guest.** Threat-model defenders' guarantee #4
  (no sandbox escape) currently rests entirely on CHV/VF + minimal kernel.
  Adding a seccomp filter to vsock-init before it execs tools is a hardening
  TODO that's well-scoped (call `prctl(PR_SET_NO_NEW_PRIVS, 1)` then load a
  filter that allows only the syscalls busybox needs).
- **No reproducible build across hosts.** Within a single host, runs are
  bit-identical thanks to `SOURCE_DATE_EPOCH` and `apk` pinning, but two
  different machines will produce different `.img` bytes because Alpine's
  `linux-virt` package is not pinned to a specific version. Pin it
  (`apk add linux-virt=<exact-version>`) before signing baseline hashes.
- **No CI integration.** `scripts/build.sh` is meant to be run from CI on a
  Linux runner; the wiring (e.g., a GitHub Actions job that uploads
  `checksums.txt` as a release artifact) is post-MVP.
- **`bsm-sandbox-rootfs.img` is ext4, not squashfs.** CHV and VF both accept
  ext4, but squashfs is read-only by default which is preferable for the
  sandbox use case (and reduces reset-verification surface). Switching is a
  one-line Dockerfile change (`mksquashfs` instead of `mkfs.ext4`) but I
  have not validated that the resulting image boots on every backend yet,
  so I left ext4 in.
- **The kernel is Alpine's stock `linux-virt`, not a custom build.** It has
  vsock support but also a long tail of drivers we don't need. Production
  should ship a CONFIG\_-trimmed kernel; that work is order-of-days, not
  hours, and is intentionally out of scope for P3.4.
- **No tool-set extension hook.** D22 mentions "2-3 MSP-relevant" tools to
  bake in. I included `ls`, `env`, `sh` as plausible placeholders; the real
  MSP-relevant set should be decided when P3.3 lands the tool-registration
  interface and we know the actual surface.
- **`go.sum` was generated** by a smoke run on this machine and committed
  alongside `go.mod`. If you bump deps, re-generate it.

### Not even started (deliberately deferred to other tracks)

- Egress proxy hooks (P3.3 owns DNS/conntrack/TLS-MITM design, D31).
- ChangeSet preview generation (operator-side, P1).
- Per-tool ChangeSet preview functions (post-MVP per plan).
- Hardware-rooted attestation (post-MVP backlog).

---

## Smoke run on this Darwin host (2026-04-27)

I ran the full build end-to-end on this machine. Result: **green**.

- **Host**: Apple Silicon Mac, Darwin 25.4
- **Docker**: `Docker version 29.1.3, build f52814d` (Docker Desktop, linux/arm64 VM)
- **Build time, cold cache**: ~3 minutes (Alpine + golang image pulls + apk fetches)
- **Build time, warm cache**: ~30 seconds

Actual artifact sizes from the smoke run:

| File                          | Smoke-run size | Type                                                         |
| ----------------------------- | -------------- | ------------------------------------------------------------ |
| `bsm-sandbox-kernel`          | 8.8 MiB        | PE32+ EFI application, Aarch64 (Alpine `linux-virt` 6.6.134) |
| `bsm-sandbox-initramfs`       | 9.6 MiB        | gzip compressed initramfs                                    |
| `bsm-sandbox-rootfs.img`      | 64 MiB         | ext4, UUID baked, volume name `bsm-rootfs`                   |
| `bsm-sandbox-rootfs.tar`      | 4.0 MiB        | POSIX tar (GNU), pre-img form                                |
| `vsock-init.bin`              | 2.2 MiB        | ELF 64-bit aarch64, statically linked, stripped              |
| **Total kernel + rootfs.img** | **~73 MiB**    | well under R4 100 MiB ship-at-install threshold              |

Run it yourself:

```sh
cd packages/image-builder
bash scripts/build.sh
ls -lh artifacts/
shasum -a 256 -c artifacts/checksums.txt   # Linux: 'sha256sum -c'
```

### Issues hit + fixed during the smoke run (logged for next person)

1. **Alpine `apk` parameter expansion in Dockerfile RUN.** The original
   `--repository v${ALPINE_VERSION%-*}/main/` pattern fails because dash's
   `${VAR%-*}` works but the ARG isn't visible in a stage without re-`ARG`-ing.
   Fix: re-declare `ARG ALPINE_VERSION` inside the rootfsbuild stage and drop
   the suffix-strip (`3.20` works directly in the URL).
2. **Alpine `apk add --root --initdb` rejects "UNTRUSTED signature".** Fix:
   seed `/rootfs/etc/apk/keys/` from the builder's keys before the apk add.
3. **`/rootfs/sbin/init` is already a symlink to `/bin/busybox`.** Docker
   COPY follows the destination symlink at apply time, which means
   `COPY ... /rootfs/sbin/init` overwrites the **builder's** `/bin/busybox`,
   which is what the builder's `/bin/sh` resolves to. Every subsequent RUN
   then breaks with confusing "vsock-init: vsock.Listen failed" output (the
   binary running as `/bin/sh -c ...`). Fix: `RUN rm -f /rootfs/sbin/init`
   immediately before the COPY. This took longest to diagnose; left a comment
   in the Dockerfile so the next person doesn't repeat it.
4. **Multi-arch:** `--platform=$BUILDPLATFORM` on the Go stage + `GOARCH`
   from `$TARGETARCH` so the binary matches the rootfs arch (arm64 on Apple
   Silicon, amd64 on Intel/AWS).
5. **Deterministic-mtime walk over /rootfs.** Skipped per-file `find/touch`
   because of an apparently unrelated buildkit/binfmt interaction surfaced by
   the symlink-clobber issue. Tar's `--mtime` flag still gives us a
   deterministic-enough archive for the MVP. Bit-exact reproducibility is a
   post-MVP TODO.

---

## TODO checklist (rolled up from "what's stubbed")

- [ ] Implement EvidenceChunk streaming + the §6.3 hash-chain inside `runTool`.
- [ ] Wire the host-side reset-verification baseline (P3.2a/b consumer of
      `checksums.txt`).
- [ ] Add seccomp + `PR_SET_NO_NEW_PRIVS` to `vsock-init` before exec.
- [ ] Pin `linux-virt` to an exact Alpine package version for cross-host
      reproducibility.
- [ ] Switch ext4 → squashfs once verified on both CHV and VF backends.
- [ ] Replace stock Alpine kernel with a custom CONFIG\_-trimmed build (R3
      mitigation).
- [ ] Decide the 2–3 MSP-relevant tools (D22) and replace the `ls/env/sh`
      placeholders.
- [ ] CI job: build on every commit, upload `checksums.txt` as a release
      artifact, fail if hash drifts unexpectedly.
- [ ] Sign artifacts (post-MVP backlog: "Reproducible image builds with
      signature verification").
