# P3.5b Validation Run — 2026-04-27, Hetzner node-2

Empirical evidence for the brainstorm endpoint-agent sandbox MVP. Captured by running `packages/sandbox/scripts/full-validation.sh` against a real Cloud Hypervisor + bare-metal Linux KVM host, after first-light's 11-iteration debugging arc landed.

## Run identity

- **Branch:** `feat/sandbox-phase-3-scaffold` at commit `7ab4d5e` (Codex-round-2 fixes applied)
- **Run started:** 2026-04-27T19:35:55Z
- **Run ended:** ~2026-04-27T19:46:10Z
- **Total wall-clock:** ~10 minutes
- **Validation harness:** `bsm-redteam --probes lat-only --iterations 1000` + `--probes concurrent --concurrency 8`

## Host

- **Host:** Hetzner bare-metal node, public address `95.217.108.251` (`compute-hel1-02`)
- **Operator:** brainstormvm peer (advisor scope per locked Phase-3 plan); node-2 owned by Justin / brainstormVM cluster
- **OS:** Ubuntu 24.04.3 LTS
- **Kernel (host):** 6.8.x (per `uname -r` at run time; running kernel after `apt-get install` queued an update — not rebooted)
- **Arch:** x86_64
- **CPU:** Hetzner-spec dedicated cores
- **RAM:** 61 GiB total
- **Free RAM at run start:** 44 GiB available (verified pre-run; verified unchanged post-run)

## Toolchain

- **Cloud Hypervisor:** v44.0.0 (binary at `/usr/bin/cloud-hypervisor`)
- **ch-remote:** v44.0.0 (downloaded from CHV GitHub release; sibling of `cloud-hypervisor`)
- **Node.js:** v22.22.2 (via NodeSource setup_22.x)
- **Docker:** v29.1.3 (Ubuntu `docker.io` package)
- **docker-buildx:** v0.30.1 (`docker-buildx` apt package — not bundled with `docker.io`; required for image-builder)

## Sandbox image

- **Sandbox kernel:** Alpine virt 6.6.134-0-virt (from `linux-virt` apk package)
- **Initramfs:** 9.2 MiB (Alpine virt initramfs)
- **Rootfs:** 256 MiB ext4 image with `linux-virt` modules + busybox + musl + alpine-baselayout
- **Boot artifacts SHA-256s recorded in:** image-builder checksums.txt (also embedded in JSON evidence)

## Concurrent host workload during the run

- `brainstormvm-cp` service active on remote CP host (87.99.142.127), unrelated to first-light
- `brainstormvm-agent` service active on this host (node-2), unrelated to first-light
- 2 unrelated Cloud Hypervisor processes from prior brainstormVM scale tests existed on host (state="Created" zombies, holding ~256 MiB RAM total). Not in firstlight namespace; phase-cleanup gates correctly avoided them. Verified zero impact on validation.

## Headline results

### 1000-iter cold-boot battery (`P-LAT`)

All four probes (boot, roundtrip, shutdown, total) passed; `1000/1000 passed`, `0 failed`, `0 errored`, `0 skipped`.

| Stage            | samples | p50   | p90 | p95 | p99     | mean  | min | max |
| ---------------- | ------- | ----- | --- | --- | ------- | ----- | --- | --- |
| **boot**         | 1000    | 586ms | 592 | 594 | **597** | 586.6 | 576 | 604 |
| roundtrip (echo) | 1000    | 2ms   | 2   | 2   | **2**   | 1.6   | 1   | 2   |
| shutdown         | 1000    | 24ms  | 30  | 31  | **36**  | 23.5  | 14  | 46  |
| **total**        | 1000    | 611ms | 620 | 622 | **628** | 611.8 | 596 | 638 |

**p99-p50 boot spread:** 11ms across 1000 cold boots. Total range 28ms across 1000 samples.

### Concurrent-8 stress (`P-CONC`)

8/8 instances PASS; allocated CIDs 3..10; unique vsock socket per instance; no CID collisions.

| Stage     | samples | p50   | p90 | p95 | p99 | mean  | min | max |
| --------- | ------- | ----- | --- | --- | --- | ----- | --- | --- |
| boot      | 8       | 725ms | 734 | 734 | 734 | 726.4 | 724 | 734 |
| roundtrip | 8       | 2ms   | 3   | 3   | 3   | 2.25  | 1   | 3   |
| shutdown  | 8       | 36ms  | 36  | 36  | 36  | 34.25 | 29  | 36  |

**Wall-clock for 8-parallel:** 765ms total (vs ~4800ms if serial — true concurrent execution verified).

### Reset cycle

**Run:** 2026-04-27T22:45:14Z (separate invocation from the P-LAT/P-CONC battery above; commit `35caba8` after two debugging iterations from the morning's `7ab4d5e`)

**Result:** PASS. `packages/sandbox/scripts/reset-cycle.sh` exit 0; driver exit 0; substrate-lying defense (§A6) fired as designed.

```
first reset (clean):    divergence_action=none verification_passed=true
tamper:                 appended sentinel byte to bsm-sandbox-rootfs.img
second reset (lying):   SandboxResetDivergenceError
                        fs_match=false fd_match=true vmm_match=true
                        (divergence_action=halt)
```

All three independent sources behaved as the threat model claims:

- **Source 1 (filesystem hash):** dispositive — caught the substrate tamper (`fs_match=false`)
- **Source 2 (open-fd count):** stable across CHV restore + vsock re-handshake
- **Source 3 (VMM API state):** stable across restore

**Bugs caught and fixed during reset-cycle bring-up (5 iterations):**

| Iter | Symptom                               | Root cause                                                                                                                                              | Fix                                                                                                                  |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | driver path resolution                | `.mjs` outside workspace can't resolve `@brainst0rm/sandbox`                                                                                            | write driver into `<repo>/packages/sandbox/.tmp/`                                                                    |
| 2    | "VM is already created"               | ch-remote restore refused on Running VM                                                                                                                 | `snapshotRevert` does shutdown → delete → restore → resume                                                           |
| 3    | "peer hung up" post-restore           | host-side vsock connection invalidated by CHV restore                                                                                                   | re-establish vsock via `openVsockWithRetry` post-restore                                                             |
| 4    | `fs_match=true` always (silent no-op) | snapshot-create + reset-cycle.sh hashed phantom `BSM_OVERLAY` file CHV never wrote — baseline fs_hash was `sha256:e3b0c44...` (SHA-256 of empty string) | snapshot-create + reset-cycle.sh both default `BSM_OVERLAY` to `BSM_ROOTFS` (the file CHV's `--disk` actually reads) |
| 5    | `fd_match=false` after restore        | `openFdCount()` counted socket fds; new vsock connection topology post-restore changed socket-fd count                                                  | filter `S_IFSOCK` from fd count; metric is now "non-socket fd count" — stable across reset                           |

Iter 4's bug (empty-hash) is the highest-severity catch: the §A6 substrate-lying defense was previously a silent 2-source-effective rather than 3-source — fs_match was trivially passing every run regardless of substrate state. Caught by recognizing `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` as `SHA-256("")` in baseline JSON. Cost-of-catch ratio: ~5min review attention vs. months of fake-pass evidence accumulating before tamper detection failed in a real attack.

**Stale-artifact gotcha (test harness bug):** Run-6 (intermediate) came back with the OLD failure pattern despite the fixes being merged. Cause: `reset-cycle.sh` step 3 only checks for artifact existence, not mtime against `packages/image-builder/vsock-init/main.go`. The pre-fix `bsm-sandbox-rootfs.img` (21:03Z) was reused even though `main.go` (22:43Z) had the S_IFSOCK fix. Resolved by manually deleting artifacts to force rebuild; flagged to peer for harness fix.

## Cluster delta (post-1008 cold boots + 8 parallel)

| Metric                          | pre-run | post-run                                        |
| ------------------------------- | ------- | ----------------------------------------------- |
| Free RAM                        | 44 GiB  | 44 GiB (unchanged)                              |
| firstlight CHV processes        | 0       | **0**                                           |
| Leftover vsock sockets          | 0       | **0**                                           |
| Leftover per-VM rootfs overlays | 0       | **0**                                           |
| Unrelated CHV zombies           | 2       | 2 (unchanged — phase-cleanup correctly avoided) |

**Zero leaks across 1008 cold boots + 8 parallel instances.**

## Failure modes that did NOT occur (worth naming)

- No memory leaks (free RAM identical pre/post)
- No socket leaks (zero leftover Unix sockets in /var/lib/firstlight/)
- No process leaks (zero leftover CHV processes in firstlight namespace)
- No CID collisions during concurrent allocation (CIDs 3..10 cleanly unique)
- No vsock-init crashes (no fatalAsPID1 heartbeats observed)
- No kernel panics (1000+ guest boots without "Attempted to kill init")
- No CHV API errors (1000+ create/boot/shutdown cycles via REST API + ch-remote)
- No host workload impact (brainstormvm-agent + 2 unrelated zombies undisturbed)

## Provenance chain

This evidence was produced via the standard run flow:

1. PR #277's `feat/sandbox-phase-3-scaffold` + Codex-round-2 fixes (`7ab4d5e`) cloned to `/var/lib/firstlight/brainstorm` on Hetzner node-2
2. `bash packages/sandbox/scripts/full-validation.sh` invoked at 19:35:55Z
3. Three sub-reports + master report generated to `/var/lib/firstlight/`
4. SCP'd to `/Users/justin/Projects/brainstorm/docs/validation-runs/2026-04-27-node-2/` for repo persistence
5. log-tail.txt is the last 500 lines of the full validation log (full log too large for repo at ~10 MB)

## Cross-references

- **Plan:** `docs/endpoint-agent-plan.md` v3.1, §5 Phase-3 sandbox track, P3.5b validation gate
- **Threat model:** `docs/endpoint-agent-threat-model.md` v1, §7 Red-Team Test Battery (P-LAT and P-CONC are the latency + concurrency probes)
- **First-light driver:** `packages/sandbox/scripts/first-light.sh` (one-iter sanity baseline)
- **Validation harness:** `packages/sandbox/scripts/full-validation.sh` (invoked here)
- **brainstormvm operator notes:** brainstormVM peer's project memory `project_first_real_godmode_vm.md` (the brainstormVM-side first-real-VM milestone from earlier the same week, on the same host)

## What this evidence supports vs does NOT support

**Supports:**

- Cold-boot latency claim: sub-second p99 (597ms) for sandbox bringup with full vsock RPC ready
- Concurrency claim: ≥8 simultaneous sandboxes with isolated CIDs/sockets work
- Resource discipline claim: phase-cleanup + trap-on-EXIT prevents leaks across thousands of dispatches
- Stay-fixed claim: every iteration's fix from first-light's 11-layer debugging holds at scale
- **Reset-cycle correctness:** snapshot → restore → re-handshake → verify cleanly distinguishes clean from tampered substrate (§A6)
- **Substrate-lying (§A6) defense:** all three independent sources active and behaving per threat model — fs_hash dispositive on tamper, fd_count and vmm_state stable across restore

**Does NOT yet support:**

- Sandbox escape attempts (P-T2 — not in this run)
- Network egress audit (P-T3 — not in this run)
- Long-running workload (this is cold-boot only; sustained dispatch over hours not measured)
- Reset cadence under sustained pressure (single tamper-detect verified, but not 100s of consecutive resets)

These are the next P3.5a/b deliverables.
