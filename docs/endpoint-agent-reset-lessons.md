# Endpoint-agent reset-cycle lessons

**Audience:** Implementers of the v1.0.0 endpoint agent (Go, Rust, or other) who need the protocol's reset semantics encoded with the same hard-won corrections that the TS reference at `packages/endpoint-stub/` and `packages/sandbox/` already bake in.

**Why this doc exists:** the FROZEN wire spec at `docs/endpoint-agent-protocol-v1.md` describes the protocol _as it should be_. This doc describes _what we learned about it from real Cloud Hypervisor iteration on Hetzner node-2_. Spec-only reading would force a re-derivation; this doc shortcircuits 1-2 days of git archaeology and saves implementers from re-discovering each catch the hard way.

The lessons are listed in the order they were learned (chronological-per-iteration), each with: symptom, root cause, fix, what it generalizes to.

---

## Lesson 0: Iteration backbone

Before the lessons themselves: the meta-pattern that produced them.

Each numbered lesson came from a single `bash full-validation.sh` (or `reset-cycle.sh`) run on Hetzner node-2 against real `cloud-hypervisor` v44.0.0 + KVM. We pushed a fix, peer ran, log + artifacts came back, diagnosis happened in a 1-2 message round, next push. Wall-clock 5-10 min per round. **Five rounds got reset-cycle from "scaffold" to "PASS with §A6 substrate-lying defense empirically validated."**

The meta-lesson: **mock tests cannot surface CHV-state-machine bugs**. Every catch below was invisible to local mock-only test suites, even when those suites had high coverage and passed cleanly. Real-CHV iteration is the dispositive validation channel. Plan for it; don't skip to mock-only.

---

## Lesson 1 — `ch-remote restore` requires an empty VM slot

**Symptom (run-3):**

```
SandboxResetError: reset failed:
  ch-remote restore failed: Command failed: ch-remote --api-socket ... restore source_url=file:///var/lib/firstlight/golden-...
  Error running command: Server responded with an error:
  InternalServerError: Some("VM is already created")
```

**Root cause:** Cloud Hypervisor's `restore` REST endpoint creates a fresh VM from a snapshot — it requires the VMM slot to be EMPTY. Calling `restore` while a VM is `Running` (which we always are at reset time, since the operator just dispatched a tool through it) produces `VM is already created`.

**Spec-side intuition that's wrong:** "snapshot/restore is symmetric — `snapshot` paused-VM-then-snapshots, `restore` should snapshots-then-resume." Empirically: snapshot creates the file at any state (we pause first ourselves); restore needs the slot empty.

**Fix (commit `a7d9fb9`):** before `ch-remote restore`, the reset path issues:

```
1. ch-remote shutdown   # stop the running VM (guest off)
2. ch-remote delete     # remove VM definition (slot empty)
3. ch-remote restore    # load fresh VM from snapshot
4. ch-remote resume     # un-pause restored VM
```

The VMM (cloud-hypervisor process) stays alive across all four. Only the VM-within-the-VMM cycles.

**TS reference:** `packages/sandbox/src/chv/chv-remote.ts` `snapshotRevert()`.

**Generalizes to:** any host-side RPC that "restores" or "loads from snapshot" probably has a state-machine prerequisite. Check the API surface for shutdown/delete-equivalents and prepend them. Mock tests that just mock the verb sequence won't catch the missing prerequisite — they already assume it succeeded.

---

## Lesson 2 — vsock connections do NOT survive CHV restore

**Symptom (run-4):**

```
SandboxResetDivergenceError: reset verification diverged:
  fs_match=true fd_match=false vmm_match=true (divergence_action=halt)
[chv-sandbox] open_fd_count query failed: vsock closed (treating as divergence)
```

The shutdown→delete→restore→resume sequence succeeded. Then `verifyPostReset()` tried to query the guest for `OpenFdCount` over the existing vsock connection — and got "vsock closed."

**Root cause:** CHV's `restore` replaces the entire kernel including the socket table. The host's pre-existing vsock connection was bound to the pre-restore VM's accepted-connection state; that VM is gone, the host's socket has no peer, and both ends are dead by the time `restore` returns. The threat-model §A6 design said "use the same connection install-time and runtime both use" — but "same connection" can't survive a restore.

**Spec-side intuition that's wrong:** "restore preserves all VM state including network connections." Empirically: it preserves _kernel memory state_ (the snapshot's snapshot of fd-table-at-snapshot-time), but the actual socket peers are gone — the kernel's view of the world is restored, but the world isn't.

**Fix (commit `f28a1bc`):** between `snapshotRevert()` and `verifyPostReset()`, close the dead vsock and re-handshake via `openVsockWithRetry(30_000)` — same handshake `boot()` uses. The design's intent (FD-overhead symmetry) is preserved at the connection-shape level: one CONNECT, same guest port, same probe-FD overhead. The literal socket object is replaced; the _shape_ matches install-time baseline.

**TS reference:** `packages/sandbox/src/chv/chv-sandbox.ts` `reset()` after `snapshotRevert()`.

**Generalizes to:** any reset semantics that traverses a hypervisor restore boundary. Connection-state IS lost; design verification metrics to be invariant under connection-shape, not connection-identity.

---

## Lesson 3 — Empty hash baselines are silent no-ops

**Symptom (run-5):**

```json
"baselines": {
  "fs_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "open_fd_count": 9,
  "expected_vmm_api_state": "running"
}
```

That `fs_hash` is `SHA-256("")` — the empty-string hash. **Famous tell.** If the baseline is hashing nothing, then `verifyPostReset()` is comparing empty-vs-empty and `fs_match=true` is trivially passing every run, regardless of substrate state.

**Root cause:** `reset-cycle.sh` was creating a separate empty `${RESET_CYCLE_DIR}/overlay-${TS}.img` file and passing it as `BSM_OVERLAY`. CHV uses `--disk path=<rootfs>,readonly=on` and never wrote there → the overlay stayed empty across every run → snapshot-create hashed empty bytes → baseline = SHA-256("") → runtime hash was always SHA-256("") → `fs_match=true` regardless of substrate state. **The §A6 substrate-lying defense was a silent no-op.**

This is the highest-severity catch in the iteration sequence. The defense's load-bearing claim was structurally compromised by a configuration trap that LOOKED right (overlay file existed; baseline was populated; verification ran without errors; tests passed; CI was green).

**Spec-side intuition that's wrong:** "if the JSON is well-formed and the baseline value looks plausible, the verification semantics work." Empirically: SHA-256("") is a well-formed plausible-looking sha256 value. Don't trust that the verification path hashes meaningful bytes without checking the bytes themselves.

**Fix (commit `35caba8`, first half):**

1. Drop the phantom separate-overlay path. snapshot-create defaults `BSM_OVERLAY` to `BSM_ROOTFS` (the file CHV's `--disk` actually points at, matching `RootfsConfig.overlayPath`'s default-to-`path`).
2. `reset-cycle.sh` tampers `BSM_ROOTFS` for the substrate-lying simulation.
3. Codex round-2 had already added `RootfsConfig.overlayPath`; making it default-to-`path` makes the simple case correct without operator configuration.

**TS reference:** `packages/sandbox/scripts/snapshot-create.ts` (overlay-defaults-to-rootfs); `packages/sandbox/src/chv/chv-config.ts` `RootfsConfig.overlayPath` documentation.

**Generalizes to:** any verification that hashes "the substrate." Validate that the bytes-being-hashed are non-trivial AND attributed to the right file. If hashing produces SHA-256("") or SHA-256("\n") or other identity-of-empty values, treat that as divergence — the defense is silently no-op.

---

## Lesson 4 — Fd-count topology asymmetry across restore

**Symptom (run-5, second half):**

After lesson-2's vsock re-handshake fix, the open-fd count source was producing `fd_match=false` on every reset, even with no real divergence.

**Root cause:** vsock-init's `openFdCount()` returned `len(/proc/self/fd)` which includes socket fds. After CHV restore + host re-handshake, the connection topology differs from snapshot-time baseline:

- Install-time: vsock-init has `[stdin, stdout, stderr, vsock-listener, accepted-conn-A]` = 5 fds.
- Snapshot captures fd-table-at-snapshot-time including `accepted-conn-A`.
- Runtime restore: kernel-memory-state restored; `accepted-conn-A` is now zombied (host peer gone).
- Host re-handshake: new `accepted-conn-B` added.
- Total: `[stdin, stdout, stderr, vsock-listener, zombie-A, accepted-conn-B]` = 6 fds.

Baseline was 5. Runtime is 6. `fd_match=false` for a reason that has _nothing_ to do with the metric's intent ("did the guest leak any non-socket resources across reset").

**Spec-side intuition that's wrong:** "fd count is a stable cross-restore invariant of guest state." Empirically: fd count includes socket-topology state, which CHV's restore changes by design.

**Fix (commit `35caba8`, second half):** `vsock-init.openFdCount()` filters S_IFSOCK fds. The metric is now "non-socket fd count" — stable across restore + re-handshake, still catches real leaks of file handles / pipes / eventfds / etc. Symmetric across baseline-capture and runtime-query.

**Go reference (image-builder):** `packages/image-builder/vsock-init/main.go` `openFdCount()`.

**Generalizes to:** any metric that's supposed to be invariant across reset. Audit what _kinds_ of state it captures; subtract anything that the restore boundary necessarily changes by construction. Filter at the source (the in-guest agent) so install-time and runtime both produce the filtered count, not at the verifier (which would have to subtract something asymmetrically).

---

## Lesson 5 — Validation-harness staleness is its own bug class

**Symptom (run-6):** Operator (0bz7aztr) ran reset-cycle.sh after pushing the fixes from lessons 1+2+3+4. **Got the OLD failure pattern.** They were briefly confused — almost messaged me about a "fix that didn't apply." Then checked artifact mtimes:

```
rootfs.img:  2026-04-27 21:03:27  (pre-fix)
main.go:     2026-04-27 22:43:46  (post-fix, just pulled)
```

The script's image-builder gate was a pure existence-check. The fix was in vsock-init source. The .img on disk was the old build. The harness happily ran the OLD binary against the FRESH source-side fixes and produced stale validation results.

**Root cause:** existence-only check for image artifacts. The harness was implicitly assuming "if rootfs.img exists, it reflects the current vsock-init source." That assumption is wrong every time vsock-init changes.

**Why this is its own lesson rather than just a bug:** the asymmetry of harness staleness is what makes it dangerous. It can mask both:

- **A FIX** (operator pushed a fix; harness reuses old binary; fix appears not to work; operator either reverts or escalates as a regression — temporary cost).
- **A REGRESSION** (operator introduced a bug in vsock-init; harness reuses old non-bug binary; tests still pass; bug ships silently — silent cost, much worse).

Second case is the load-bearing one. "Tests pass" should mean "tests of the current code pass," not "tests of some historical artifact pass."

**Fix (commit `346ee0e`):** `packages/image-builder/scripts/lib-stale-check.sh` exposes `image_artifacts_stale REPO_ROOT` which compares rootfs.img mtime against newest source under `vsock-init/`, `build/`, scripts/. If newer source exists, force rebuild. Wired into `reset-cycle.sh` and `full-validation.sh`'s image-build gates. `SKIP_IMAGE_BUILD=1` operator override preserved for explicit-bypass cases.

**Generalizes to:** any test harness that has a "reuse if present" optimization on a derived artifact. The rule: **the harness itself must verify its inputs are fresh, not just present.** Existence ≠ wired-to-current-source. This is the recursive form of the exists-vs-wired discipline that already governs feature code.

---

## Per-implementation cross-reference

For Go implementers picking up P1.3 brainstorm-agent:

| Lesson                     | TS reference for the fix                        | Go-side implication                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1: ch-remote state machine | `chv-remote.ts` `snapshotRevert()`              | When wrapping libvirt or any other VMM RPC: enumerate the state-machine prerequisites for each verb. Mock tests won't surface them. Plan for at least one CHV-runner round to flush them.                          |
| 2: vsock-survival          | `chv-sandbox.ts` `reset()` post-revert          | Re-handshake the vsock between revert and verify. Don't trust pre-restore connections. The threat-model §A6 "same connection" framing is misleading; "same shape" is what matters for FD-overhead symmetry.        |
| 3: empty-hash baselines    | `snapshot-create.ts` overlay-defaults-to-rootfs | Validate that hash baselines are non-trivial bytes BEFORE shipping them. SHA-256("") is the canary; if you see it in a baseline JSON, the verification path is silently no-op. Refuse to start with that baseline. |
| 4: fd-count topology       | vsock-init's `openFdCount()` filters S_IFSOCK   | Any in-guest verification metric: subtract state the restore boundary changes by construction. Filter at the source (in-guest agent), not at the verifier.                                                         |
| 5: harness staleness       | `lib-stale-check.sh`                            | Test harnesses MUST verify input freshness, not just existence. Recursive exists-vs-wired discipline: applies to the harness itself.                                                                               |

---

## What this doc is NOT

- Not a rewrite of `docs/endpoint-agent-protocol-v1.md` (that's the FROZEN spec; this is the _reading order alongside it_ for implementers).
- Not a critique of the v1.0.0 design — every lesson here is consistent with the spec's intent; they're catches at the **implementation/empirical** layer, not the wire-protocol layer. The spec's a sound foundation.
- Not a complete catalog. Five real-CHV iteration rounds + three Codex review rounds produced ~14 catches total; the five above are the most generalizable. Other catches are in the squashed PR commit messages (`a1693f5`, `31a0194`); read those for full coverage.

## Credits

- **Real-CHV iteration:** 0bz7aztr (brainstormvm peer), operating Hetzner node-2 as hands-on-cluster across 5+5 iteration rounds.
- **Three Codex rounds:** structured adversarial review caught 7 BLOCKERS pre-merge.
- **Spec authorship + orchestration:** brainstorm orchestrator session 2026-04-27.

The protocol made the bugs catchable. People actually caught them. This doc is the artifact of that combination.
