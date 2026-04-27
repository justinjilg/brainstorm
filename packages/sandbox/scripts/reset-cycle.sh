#!/usr/bin/env bash
# CHV reset-cycle validation driver (P3.2a integration).
#
# Goal: prove that the install-time golden-snapshot flow + runtime
# 3-source verification together detect a substrate-lying attacker who
# tampers with the rootfs CoW overlay between dispatches.
#
# Pipeline:
#   1. Sanity-check the host (KVM, binaries) — re-uses first-light gating
#   2. Build sandbox (incl. snapshot-create.js)
#   3. Build kernel + initramfs + rootfs.img if absent
#   4. Run snapshot-create → mints golden snapshot + emits baseline JSON
#   5. Boot a fresh ChvSandbox with that JSON, run an echo dispatch,
#      reset() → expect divergence_action="none" (clean reset)
#   6. Tamper with the overlay file (simulate substrate-lying attacker)
#   7. reset() again → MUST throw SandboxResetDivergenceError
#   8. Report PASS if the second reset throws, FAIL otherwise
#
# Tampering method: `printf '...' >> "$BSM_OVERLAY"`. Plain shell append
# is the simplest possible mutation — it changes the file's bytes, which
# makes the streaming SHA-256 hash diverge from baseline.fs_hash. We
# considered `dd seek=...` (sector-level) and `mount -o loop && touch`
# (filesystem-level), but both rely on host privileges (root, loop
# device availability) that the validation runner shouldn't need. The
# defense we're testing is *hash-based* — any byte change breaks it,
# so the simplest tamper that perturbs bytes is the right test.
#
# What proves the defense works:
#   - second reset() exits non-zero AND stderr contains
#     "SandboxResetDivergenceError" or "divergence_action=halt"
#
# What proves the defense fails (i.e. SECURITY-CRITICAL bug):
#   - second reset() returns successfully (exit 0)
#   - OR exits non-zero but with a different error class
#     (we treat boot/setup errors as INCONCLUSIVE rather than PASS,
#     because a generic crash isn't proof the integrity monitor caught
#     the tamper)
#
# Usage (from monorepo root):
#   bash packages/sandbox/scripts/reset-cycle.sh
#
# Override defaults via env:
#   RESET_CYCLE_DIR=/var/lib/firstlight  (where logs + artifact paths land)

set -uo pipefail

RESET_CYCLE_DIR="${RESET_CYCLE_DIR:-/var/lib/firstlight}"
TS=$(date +%Y%m%d-%H%M%S)
LOG="${RESET_CYCLE_DIR}/reset-cycle-${TS}.log"
JSON_OUT="${RESET_CYCLE_DIR}/reset-cycle-baselines-${TS}.json"
DRIVER_OUT="${RESET_CYCLE_DIR}/reset-cycle-driver-${TS}.log"
SNAPSHOT_DIR="${RESET_CYCLE_DIR}/golden-${TS}"
# OVERLAY no longer pre-created as a separate file — the tamper target
# is now BSM_ROOTFS itself (the actual file CHV's --disk reads). The
# earlier separate-overlay path produced an empty-file → SHA-256("")
# baseline → silent no-op for the substrate-lying defense. (run-5 catch.)
VSOCK_SOCK="${RESET_CYCLE_DIR}/reset-cycle-${TS}-vsock.sock"
API_SOCK="${RESET_CYCLE_DIR}/reset-cycle-${TS}-api.sock"

# The driver `.mjs` MUST live inside the workspace so Node's normal
# package resolution finds `@brainst0rm/sandbox` via the workspace's
# node_modules symlink. Writing it to RESET_CYCLE_DIR (typically
# /var/lib/firstlight) breaks the import — caught by 0bz7aztr on
# run-2 with ERR_MODULE_NOT_FOUND.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DRIVER_TMP_DIR="${REPO_ROOT}/packages/sandbox/.tmp"

mkdir -p "$RESET_CYCLE_DIR" "$DRIVER_TMP_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "=== CHV reset-cycle driver (P3.2a) ==="
echo "host:     $(hostname)  arch: $(uname -m)  kernel: $(uname -r)"
echo "log:      $LOG"
echo "snapshot: $SNAPSHOT_DIR"
echo "tamper-target: ROOTFS (=overlay default; CHV's readonly disk file)"
echo "json:     $JSON_OUT"
echo

# ---- 1. host sanity (light) -------------------------------------------
fail=0
have() { command -v "$1" >/dev/null 2>&1; }
if [[ ! -e /dev/kvm ]]; then echo "MISSING /dev/kvm"; fail=1; fi
for bin in cloud-hypervisor ch-remote node; do
  if have "$bin"; then
    echo "OK   $bin: $($bin --version 2>&1 | head -1)"
  else
    echo "MISS $bin (install before running)"
    fail=1
  fi
done
if [[ $fail -ne 0 ]]; then
  echo
  echo "host sanity FAILED — fix the above and re-run"
  exit 3
fi

# ---- 2. build sandbox -------------------------------------------------
echo
echo "=== step 2: build sandbox (incl. snapshot-create.js) ==="
cd "$(dirname "$0")/../../.."   # monorepo root
npx turbo run build --filter='@brainst0rm/sandbox' \
  || { echo "sandbox build failed"; exit 4; }

if [[ ! -f packages/sandbox/dist/scripts/snapshot-create.js ]]; then
  echo "FATAL: dist/scripts/snapshot-create.js not produced by tsup"
  ls -la packages/sandbox/dist/scripts/ || true
  exit 4
fi

# ---- 3. images (reuse if present) -------------------------------------
echo
echo "=== step 3: ensure kernel + rootfs ==="
KERNEL="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-kernel"
INITRAMFS="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-initramfs"
ROOTFS="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-rootfs.img"

# Source the staleness-check helper. (0bz7aztr's run-6 catch — pure
# existence checks were letting old vsock-init binaries run against
# fresh source, masking both fixes and regressions.)
. packages/image-builder/scripts/lib-stale-check.sh
if [[ ! -f "$KERNEL" || ! -f "$INITRAMFS" || ! -f "$ROOTFS" ]]; then
  echo "image artifacts missing — running image-builder"
  bash packages/image-builder/scripts/build.sh \
    || { echo "image-builder failed"; exit 4; }
elif image_artifacts_stale "$(pwd)"; then
  echo "image artifacts present but STALE relative to image-builder source —"
  echo "running image-builder to refresh"
  rm -f "$KERNEL" "$INITRAMFS" "$ROOTFS" \
        packages/image-builder/artifacts/bsm-sandbox-rootfs.tar \
        packages/image-builder/artifacts/vsock-init.bin \
        packages/image-builder/artifacts/checksums.txt
  bash packages/image-builder/scripts/build.sh \
    || { echo "image-builder failed"; exit 4; }
else
  echo "image artifacts present and fresh"
fi

if [[ ! -f "$KERNEL" || ! -f "$INITRAMFS" || ! -f "$ROOTFS" ]]; then
  echo "image artifacts STILL missing after build:"
  ls -la packages/image-builder/artifacts/
  exit 4
fi
echo "kernel:    $KERNEL"
echo "initramfs: $INITRAMFS"
echo "rootfs:    $ROOTFS"

# ---- 4. snapshot-create -----------------------------------------------
echo
echo "=== step 4: mint golden snapshot + baseline JSON ==="
mkdir -p "$SNAPSHOT_DIR"
rm -f "$VSOCK_SOCK" "$API_SOCK"

export BSM_KERNEL="$KERNEL"
export BSM_INITRAMFS="$INITRAMFS"
export BSM_ROOTFS="$ROOTFS"
# BSM_OVERLAY intentionally NOT set — snapshot-create defaults it to
# BSM_ROOTFS (the file CHV's --disk actually points at). Earlier
# scripting passed a separate empty file, which produced SHA-256("")
# baselines and silently no-op'd Source 1. (0bz7aztr's run-5 catch.)
export BSM_SNAPSHOT_DIR="$SNAPSHOT_DIR"
export BSM_VSOCK_SOCKET="$VSOCK_SOCK"
export BSM_API_SOCKET="$API_SOCK"
export BSM_GUEST_PORT="${BSM_GUEST_PORT:-52000}"

# stdout of snapshot-create is JSON; stderr is progress. Capture both.
if ! node packages/sandbox/dist/scripts/snapshot-create.js \
    --output="$JSON_OUT" \
    > "${JSON_OUT}.stdout" 2> "${JSON_OUT}.stderr"; then
  rc=$?
  echo "snapshot-create FAILED (rc=$rc):"
  echo "--- stderr ---"
  cat "${JSON_OUT}.stderr"
  echo "--- stdout ---"
  cat "${JSON_OUT}.stdout"
  exit 4
fi
echo "snapshot-create PASS — baseline JSON at $JSON_OUT"
echo "--- baseline JSON ---"
cat "$JSON_OUT"
echo "--- end ---"

# ---- 5/6/7. drive reset cycle through a Node helper -------------------
# Inline node helper: load the JSON, build a ChvSandbox config, boot,
# echo, reset (expect clean), tamper overlay, reset (expect throw).
echo
echo "=== step 5/6/7: reset-cycle driver ==="
# Reuse the same sockets — purge first.
rm -f "$VSOCK_SOCK" "$API_SOCK"

DRIVER_JS="${DRIVER_TMP_DIR}/reset-cycle-driver-${TS}.mjs"
# Always remove the temp driver on exit (success or failure) so the
# workspace stays clean.
trap 'rm -f "$DRIVER_JS"' EXIT
cat > "$DRIVER_JS" <<'EOF'
// Reset-cycle driver. Loads the snapshot-create JSON, boots a fresh
// ChvSandbox with it, runs the clean reset → tamper → divergent reset
// pipeline. Exit codes:
//   0  PASS  (first reset clean, second reset threw divergence)
//   10 FAIL  (first reset diverged unexpectedly)
//   20 FAIL  (second reset did NOT throw — defense compromised)
//   30 FAIL  (second reset threw but with the wrong error class —
//            inconclusive, treated as FAIL for safety)
//   40 ERROR (boot or echo dispatch failed before we could test the
//            cycle; not a defense failure, just a setup failure)
import { readFileSync, appendFileSync } from "node:fs";

const JSON_PATH = process.env.JSON_PATH;
const KERNEL = process.env.BSM_KERNEL;
const INITRAMFS = process.env.BSM_INITRAMFS;
const ROOTFS = process.env.BSM_ROOTFS;
const VSOCK_SOCK = process.env.BSM_VSOCK_SOCKET;
const API_SOCK = process.env.BSM_API_SOCKET;
const GUEST_PORT = parseInt(process.env.BSM_GUEST_PORT || "52000", 10);
// Tamper target = the file CHV's --disk path= actually points at. With
// `readonly=on` CHV doesn't write here, so the snapshot/restore round-
// trip never touches these bytes; an external tamper of these bytes
// is exactly what FS-hash verification should detect. Default to
// ROOTFS to match the new RootfsConfig.overlayPath default — the
// earlier separate empty-file path produced SHA-256("") baselines.
// (0bz7aztr's run-5 catch.)
const OVERLAY = process.env.BSM_OVERLAY ?? ROOTFS;

const log = (m) => {
  process.stderr.write(`[reset-cycle-driver] ${m}\n`);
};

const baseline = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
log(`loaded baseline JSON: snapshotPath=${baseline.snapshotPath}`);

const { ChvSandbox, SandboxResetDivergenceError } = await import(
  "@brainst0rm/sandbox"
);

const sandbox = new ChvSandbox({
  apiSocketPath: API_SOCK,
  kernel: { path: KERNEL, initramfs: INITRAMFS },
  rootfs: {
    path: ROOTFS,
    overlayPath: OVERLAY,
    readonly: true,
  },
  vsock: { socketPath: VSOCK_SOCK, guestPort: GUEST_PORT },
  cpus: 2,
  memMib: 1024,
  snapshotPath: baseline.snapshotPath,
  baselines: baseline.baselines,
});

try {
  log("boot...");
  await sandbox.boot();
  if (sandbox.state() !== "ready") {
    log(`unexpected state: ${sandbox.state()}`);
    process.exit(40);
  }

  log("echo dispatch...");
  const result = await sandbox.executeTool({
    command_id: `reset-cycle-${Date.now()}`,
    tool: "echo",
    params: { message: "pre-reset hello" },
    deadline_ms: 30_000,
  });
  if (result.exit_code !== 0) {
    log(`echo failed exit_code=${result.exit_code} stderr=${result.stderr}`);
    process.exit(40);
  }
  log(`echo OK: ${result.stdout.trim()}`);

  // --- first reset: should be CLEAN -----------------------------------
  log("first reset (expect clean)...");
  let firstReset;
  try {
    firstReset = await sandbox.reset();
  } catch (e) {
    log(`first reset threw unexpectedly: ${e.constructor.name}: ${e.message}`);
    process.exit(10);
  }
  log(
    `first reset: divergence_action=${firstReset.verification_details.divergence_action} ` +
      `verification_passed=${firstReset.verification_passed}`,
  );
  if (firstReset.verification_details.divergence_action !== "none") {
    log("FAIL: first reset diverged when overlay was untampered");
    process.exit(10);
  }

  // --- tamper with overlay --------------------------------------------
  // Append a sentinel to the CoW file. Streaming SHA-256 of the
  // post-tamper file MUST disagree with baseline.fs_hash, so the next
  // reset's verifyPostReset fires divergence.
  //
  // Why simple `>>` append: the integrity monitor hashes BYTES; any
  // change of any kind breaks the hash. We deliberately don't go through
  // mount/loop/dd because that adds privilege requirements without
  // testing anything additional — the defense is hash-vs-baseline, full
  // stop. A simple shell append exercises that exact path.
  log(`tampering: appending substrate-lie sentinel to ${OVERLAY}`);
  appendFileSync(
    OVERLAY,
    `\nSUBSTRATE_LIE_SENTINEL_${Date.now()}_${Math.random()}\n`,
  );

  // --- second reset: should THROW SandboxResetDivergenceError ---------
  log("second reset (expect SandboxResetDivergenceError)...");
  let caught = null;
  try {
    const second = await sandbox.reset();
    log(
      `second reset returned without throwing: ${JSON.stringify(
        second.verification_details,
      )}`,
    );
  } catch (e) {
    caught = e;
  }

  if (caught === null) {
    log("FAIL: second reset did NOT throw — substrate-lying defense BROKEN");
    process.exit(20);
  }
  if (!(caught instanceof SandboxResetDivergenceError)) {
    log(
      `FAIL (inconclusive): second reset threw ${caught.constructor.name} ` +
        `not SandboxResetDivergenceError. Message: ${caught.message}`,
    );
    process.exit(30);
  }
  log(`PASS: second reset threw SandboxResetDivergenceError as expected`);
  log(`  message: ${caught.message}`);
  process.exit(0);
} catch (e) {
  log(`uncaught driver error: ${e.constructor.name}: ${e.message}`);
  if (e.stack) log(e.stack);
  process.exit(40);
} finally {
  try {
    await sandbox.shutdown();
  } catch {}
}
EOF

export JSON_PATH="$JSON_OUT"
export BSM_OVERLAY
set +e
node "$DRIVER_JS" 2>&1 | tee "$DRIVER_OUT"
rc=${PIPESTATUS[0]}
set -e

# ---- 8. report --------------------------------------------------------
echo
echo "=== summary ==="
echo "driver exit code: $rc"
echo "log:              $LOG"
echo "driver log:       $DRIVER_OUT"
echo "baseline JSON:    $JSON_OUT"

case "$rc" in
  0)
    echo "PASS: substrate-lying defense fired on tampered overlay"
    exit 0
    ;;
  10)
    echo "FAIL: clean reset diverged (baseline mismatch on first reset — overlay non-determinism?)"
    exit 1
    ;;
  20)
    echo "FAIL: tampered reset DID NOT THROW — substrate-lying defense is broken"
    exit 1
    ;;
  30)
    echo "FAIL (inconclusive): tampered reset threw the wrong error class"
    exit 1
    ;;
  40)
    echo "ERROR: setup failure (boot/echo); reset cycle not exercised"
    exit 1
    ;;
  *)
    echo "ERROR: unexpected driver exit code $rc"
    exit 1
    ;;
esac
