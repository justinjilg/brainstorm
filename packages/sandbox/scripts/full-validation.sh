#!/usr/bin/env bash
# CHV full-validation driver (P3.5b). Run on a Linux x86_64 host with KVM,
# cloud-hypervisor, ch-remote, Node 22+, and Docker (for the image-builder).
#
# Pipeline:
#   1. Host sanity (re-uses first-light.sh's checks)
#   2. Build TS packages (sandbox + sandbox-redteam)
#   3. Build kernel + rootfs.img + initramfs (cache-friendly: skipped if
#      artifacts already exist and SKIP_IMAGE_BUILD=1, or always rebuilt
#      with FORCE_IMAGE_BUILD=1)
#   4. Cold smoke first-light (proves the path before the long battery)
#   5. 1000-iter latency battery (cold-boot + dispatch + shutdown per iter)
#   6. Concurrent-8 stress (N parallel ChvSandbox instances)
#   7. Reset cycle test — gated on P3.2a presence; skip with a clear message
#      if reset machinery isn't wired in this checkout
#   8. Single JSON summary at $VALIDATION_DIR/validation-<ts>.json
#
# Usage (from monorepo root):
#   bash packages/sandbox/scripts/full-validation.sh
#
# Override defaults via env:
#   VALIDATION_DIR=/var/lib/firstlight   (where logs + report land)
#   ITERATIONS=1000                      (latency battery iterations)
#   CONCURRENCY=8                        (concurrent stress instances)
#   SKIP_IMAGE_BUILD=1                   (reuse existing artifacts)
#   FORCE_IMAGE_BUILD=1                  (rebuild even if artifacts exist)
#   SKIP_SMOKE=1                         (skip step 4)
#   SKIP_LATENCY=1                       (skip step 5)
#   SKIP_CONCURRENT=1                    (skip step 6)

set -euo pipefail

# Validate VALIDATION_DIR upfront: must be an absolute path AND contain
# the substring "firstlight" so we can never (under any operator
# override) target /var, /var/lib, or other paths that production
# brainstormvm-agent CHV processes might live under. (Codex Q3 catch.)
VALIDATION_DIR="${VALIDATION_DIR:-/var/lib/firstlight}"
if [[ "$VALIDATION_DIR" != /* ]]; then
  echo "FATAL: VALIDATION_DIR must be an absolute path; got '$VALIDATION_DIR'"
  exit 3
fi
if [[ "$VALIDATION_DIR" != *firstlight* ]]; then
  echo "FATAL: VALIDATION_DIR must contain the substring 'firstlight' for"
  echo "       host-safety (phase cleanup uses fixed-string PID matching"
  echo "       scoped to this directory). Got: '$VALIDATION_DIR'"
  exit 3
fi
ITERATIONS="${ITERATIONS:-1000}"
# Accept CONCURRENCY or BSM_MAX_CONCURRENT (the latter is what
# 0bz7aztr's first-light coordination message used). On memory-tight
# hosts (e.g. node-2's existing 548-zombie footprint), drop this to 4.
CONCURRENCY="${CONCURRENCY:-${BSM_MAX_CONCURRENT:-8}}"
TS=$(date +%Y%m%d-%H%M%S)
LOG="${VALIDATION_DIR}/full-validation-${TS}.log"
SUMMARY="${VALIDATION_DIR}/validation-${TS}.json"

mkdir -p "$VALIDATION_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "=== CHV full-validation driver (P3.5b) ==="
echo "host:    $(hostname)  arch: $(uname -m)  kernel: $(uname -r)"
echo "log:     $LOG"
echo "summary: $SUMMARY"
echo "knobs:   ITERATIONS=$ITERATIONS CONCURRENCY=$CONCURRENCY"
if free -h >/dev/null 2>&1; then
  echo "memory:  $(free -h | awk '/^Mem:/{print $2 " total / " $7 " avail"}')"
  # Each CHV instance is configured for 1 GiB. Concurrent peak ≈ N GiB.
  echo "  concurrent-${CONCURRENCY} peak RAM estimate: ${CONCURRENCY} GiB"
fi
echo "phase staggering: each step tears down stragglers before the next starts"
echo

# Track per-step results in a JSON-friendly form. We assemble the summary
# at the end via a python heredoc so we don't depend on jq being present.
SMOKE_RC="not_run"
LAT_RC="not_run"
CONC_RC="not_run"
RESET_RC="skipped"
RESET_REASON=""
LAT_REPORT="${VALIDATION_DIR}/latency-${TS}.json"
CONC_REPORT="${VALIDATION_DIR}/concurrent-${TS}.json"

# Phase-cleanup gate. Called BETWEEN every battery so a CHV that didn't
# tear itself down cleanly can't carry over RAM/socket state into the
# next phase. Per 0bz7aztr's pre-flight RAM-headroom check on node-2.
#
# Host-safety: targets are matched by FIXED-STRING substring on
# VALIDATION_DIR using `grep -F`, NOT regex. VALIDATION_DIR is validated
# upfront to be absolute AND contain "firstlight", so we cannot under
# any operator override match production brainstormvm-agent CHV
# processes living under /var/lib/brainstormvm/ or /var/run/brainstormvm/.
# (Codex Q3 catch.)
phase_cleanup() {
  local label="$1"
  echo
  echo "  -- phase cleanup ($label): killing any stragglers + reclaiming sockets"
  # Build candidate PID list via ps + grep -F (fixed string). We require
  # the argv to contain BOTH "cloud-hypervisor" AND VALIDATION_DIR
  # before we'll touch the process — neither alone is sufficient.
  local victims
  victims=$(ps -e -o pid=,args= \
    | grep -F "cloud-hypervisor" \
    | grep -F "$VALIDATION_DIR" \
    | awk '{print $1}' \
    || true)
  if [[ -n "$victims" ]]; then
    echo "  -- found stragglers; SIGTERMing:"
    for pid in $victims; do
      ps -p "$pid" -o pid=,args= | sed 's/^/      /'
      kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 2
    # Re-check; SIGKILL anyone who didn't go down cleanly.
    for pid in $victims; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  else
    echo "  -- no stragglers (clean tear-down)"
  fi
  rm -f "${VALIDATION_DIR}"/*.sock 2>/dev/null || true
  # Brief sleep so the OS can reclaim freed pages before the next
  # phase starts allocating. Tuned for the largest gap (concurrent → reset).
  sleep 1
}

# trap exit handler so phase_cleanup runs on any path out of this script
# (smoke-fail summarise_and_exit, npm-install fail under set -e, ctrl-c
# during a battery, etc.). Idempotent.
trap 'phase_cleanup "trap-on-exit" || true' EXIT INT TERM

summarise_and_exit() {
  local rc="${1:-0}"
  echo
  echo "=== summary ==="
  echo "smoke:      $SMOKE_RC"
  echo "latency:    $LAT_RC ($LAT_REPORT)"
  echo "concurrent: $CONC_RC ($CONC_REPORT)"
  echo "reset:      $RESET_RC"
  echo "log:        $LOG"
  echo "summary:    $SUMMARY"

  python3 - "$SUMMARY" \
      "$SMOKE_RC" "$LAT_RC" "$CONC_RC" "$RESET_RC" \
      "$LAT_REPORT" "$CONC_REPORT" "$RESET_REASON" "$LOG" "$TS" \
      "$ITERATIONS" "$CONCURRENCY" "${KERNEL:-}" "${INITRAMFS:-}" "${ROOTFS:-}" <<'PYEOF'
import json, os, sys
[summary_path, smoke, lat, conc, reset, lat_report, conc_report,
 reset_reason, log_path, ts, iterations, concurrency, kernel, initramfs,
 rootfs] = sys.argv[1:16]

def load(path):
    if path and os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception as e:
            return {"_load_error": str(e)}
    return None

out = {
    "schema_version": "1.0",
    "generated_at": ts,
    "host": {
        "hostname": os.uname().nodename,
        "kernel": os.uname().release,
        "arch": os.uname().machine,
    },
    "knobs": {
        "iterations": int(iterations),
        "concurrency": int(concurrency),
    },
    "artifacts": {
        "kernel": kernel,
        "initramfs": initramfs,
        "rootfs": rootfs,
    },
    "steps": {
        "smoke": {"status": smoke},
        "latency": {
            "status": lat,
            "report_path": lat_report,
            "report": load(lat_report),
        },
        "concurrent": {
            "status": conc,
            "report_path": conc_report,
            "report": load(conc_report),
        },
        "reset": {
            "status": reset,
            "reason": reset_reason if reset == "skipped" else None,
        },
    },
    "log": log_path,
}
with open(summary_path, "w") as f:
    json.dump(out, f, indent=2)
PYEOF

  echo
  echo "JSON summary: $SUMMARY"
  exit "$rc"
}

# ---- 1. host sanity ----------------------------------------------------
echo "=== step 1: host sanity ==="
fail=0
have() { command -v "$1" >/dev/null 2>&1; }

if [[ ! -e /dev/kvm ]]; then echo "MISSING /dev/kvm"; fail=1; fi
for bin in cloud-hypervisor ch-remote node docker; do
  if have "$bin"; then
    echo "OK   $bin: $($bin --version 2>&1 | head -1)"
  else
    echo "MISS $bin (install before running)"
    fail=1
  fi
done
node_v=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ -n "$node_v" && "$node_v" -lt 22 ]]; then
  echo "WARN node is v$node_v; need 22+"
  fail=1
fi
if have docker && ! docker buildx version >/dev/null 2>&1; then
  echo "MISS docker buildx (apt-get install -y docker-buildx)"
  fail=1
fi
if [[ $fail -ne 0 ]]; then
  echo
  echo "host sanity FAILED — fix the above and re-run"
  exit 3
fi
echo "host sanity OK"

# ---- 2. build TS packages ----------------------------------------------
echo
echo "=== step 2: build sandbox + sandbox-redteam ==="
cd "$(dirname "$0")/../../.."   # monorepo root
npm install --no-audit --no-fund
npx turbo run build --filter='@brainst0rm/sandbox' --filter='@brainst0rm/sandbox-redteam' \
  || { echo "TS build failed"; exit 4; }

# ---- 3. build images (cache-friendly) ----------------------------------
echo
echo "=== step 3: build kernel + rootfs (image-builder) ==="
KERNEL="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-kernel"
INITRAMFS="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-initramfs"
ROOTFS="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-rootfs.img"

# Staleness check: if image-builder source (vsock-init/, build/Dockerfile,
# scripts/build.sh, etc.) is newer than the produced rootfs.img, force
# rebuild. (0bz7aztr's run-6 catch — pure existence-check let old vsock-
# init binaries run against fresh source, masking both fixes and
# regressions.)
. packages/image-builder/scripts/lib-stale-check.sh

need_build=1
if [[ -f "$KERNEL" && -f "$INITRAMFS" && -f "$ROOTFS" ]]; then
  if [[ "${FORCE_IMAGE_BUILD:-0}" == "1" ]]; then
    echo "FORCE_IMAGE_BUILD=1 — rebuilding images even though artifacts exist"
    need_build=1
  elif [[ "${SKIP_IMAGE_BUILD:-0}" == "1" ]]; then
    echo "SKIP_IMAGE_BUILD=1 — reusing existing artifacts (overrides staleness check)"
    need_build=0
  elif image_artifacts_stale "$(pwd)"; then
    echo "artifacts present but STALE relative to image-builder source — rebuilding"
    need_build=1
  else
    echo "artifacts present and fresh (set FORCE_IMAGE_BUILD=1 to rebuild anyway)"
    need_build=0
  fi
fi
if [[ $need_build -eq 1 ]]; then
  bash packages/image-builder/scripts/build.sh \
    || { echo "image-builder failed"; exit 4; }
fi
if [[ ! -f "$KERNEL" || ! -f "$INITRAMFS" || ! -f "$ROOTFS" ]]; then
  echo "image artifacts missing after step 3:"
  ls -la packages/image-builder/artifacts/
  exit 4
fi
echo "kernel:    $KERNEL ($(stat -c%s "$KERNEL") bytes)"
echo "initramfs: $INITRAMFS ($(stat -c%s "$INITRAMFS") bytes)"
echo "rootfs:    $ROOTFS ($(stat -c%s "$ROOTFS") bytes)"

# Common env exports for steps 4/5/6.
export BSM_KERNEL="$KERNEL"
export BSM_INITRAMFS="$INITRAMFS"
export BSM_ROOTFS="$ROOTFS"
export BSM_GUEST_PORT="${BSM_GUEST_PORT:-52000}"

# ---- 4. cold smoke first-light -----------------------------------------
if [[ "${SKIP_SMOKE:-0}" == "1" ]]; then
  echo
  echo "=== step 4: cold smoke first-light SKIPPED (SKIP_SMOKE=1) ==="
  SMOKE_RC="skipped"
else
  echo
  echo "=== step 4: cold smoke first-light ==="
  export BSM_VSOCK_SOCKET="${VALIDATION_DIR}/smoke-vsock.sock"
  export BSM_API_SOCKET="${VALIDATION_DIR}/smoke-api.sock"
  rm -f "$BSM_VSOCK_SOCKET" "$BSM_API_SOCKET"
  if node packages/sandbox/dist/scripts/first-light.js; then
    SMOKE_RC="pass"
    echo "smoke first-light: PASS"
  else
    SMOKE_RC="fail"
    echo "smoke first-light: FAIL — aborting before long batteries"
    summarise_and_exit 1
  fi
  phase_cleanup "post-smoke"
fi

# ---- 5. 1000-iter latency battery --------------------------------------
if [[ "${SKIP_LATENCY:-0}" == "1" ]]; then
  echo
  echo "=== step 5: latency battery SKIPPED (SKIP_LATENCY=1) ==="
  LAT_RC="skipped"
else
  echo
  echo "=== step 5: ${ITERATIONS}-iter latency battery ==="
  export BSM_VSOCK_SOCKET="${VALIDATION_DIR}/lat-vsock.sock"
  export BSM_API_SOCKET="${VALIDATION_DIR}/lat-api.sock"
  rm -f "${VALIDATION_DIR}"/lat-vsock.sock* "${VALIDATION_DIR}"/lat-api.sock*
  if node packages/sandbox-redteam/dist/bin/bsm-redteam.js \
      --probes lat-only \
      --iterations "$ITERATIONS" \
      --output "$LAT_REPORT"; then
    LAT_RC="pass"
    echo "latency battery: PASS — report at $LAT_REPORT"
  else
    LAT_RC="fail"
    echo "latency battery: FAIL — report at $LAT_REPORT"
  fi
  phase_cleanup "post-latency"
fi

# ---- 6. concurrent stress ---------------------------------------------
if [[ "${SKIP_CONCURRENT:-0}" == "1" ]]; then
  echo
  echo "=== step 6: concurrent-${CONCURRENCY} stress SKIPPED (SKIP_CONCURRENT=1) ==="
  CONC_RC="skipped"
else
  echo
  echo "=== step 6: concurrent-${CONCURRENCY} stress ==="
  export BSM_VSOCK_SOCKET="${VALIDATION_DIR}/conc-vsock.sock"
  export BSM_API_SOCKET="${VALIDATION_DIR}/conc-api.sock"
  rm -f "${VALIDATION_DIR}"/conc-vsock.sock* "${VALIDATION_DIR}"/conc-api.sock*
  if node packages/sandbox-redteam/dist/bin/bsm-redteam.js \
      --probes concurrent \
      --concurrency "$CONCURRENCY" \
      --output "$CONC_REPORT"; then
    CONC_RC="pass"
    echo "concurrent-${CONCURRENCY}: PASS — report at $CONC_REPORT"
  else
    CONC_RC="fail"
    echo "concurrent-${CONCURRENCY}: FAIL — report at $CONC_REPORT"
  fi
  phase_cleanup "post-concurrent"
fi

# ---- 7. reset cycle test (gated on P3.2a) ------------------------------
echo
echo "=== step 7: reset cycle test ==="
# P3.2a wires real snapshot/restore + 3-source verification. Until that
# lands, ChvSandbox.reset() returns sentinel verification with the
# ResetSandboxConfig.snapshotPath ?? skip path. We detect P3.2a by
# checking for a script the orchestrator's plan has it producing:
# packages/sandbox/scripts/reset-cycle.sh. If absent, we skip with a
# clear message rather than fabricating a green.
RESET_SCRIPT="packages/sandbox/scripts/reset-cycle.sh"
if [[ -f "$RESET_SCRIPT" ]]; then
  echo "reset-cycle script found — running"
  if bash "$RESET_SCRIPT"; then
    RESET_RC="pass"
  else
    RESET_RC="fail"
  fi
else
  RESET_RC="skipped"
  RESET_REASON="P3.2a reset machinery (snapshot/restore + 3-source verification) not in this checkout — $RESET_SCRIPT does not exist. Re-run after P3.2a lands."
  echo "reset cycle test SKIPPED: $RESET_REASON"
fi

# ---- 8. summary --------------------------------------------------------
# Determine overall exit status. Any "fail" in mandatory steps → 1.
overall=0
for step_rc in "$SMOKE_RC" "$LAT_RC" "$CONC_RC" "$RESET_RC"; do
  if [[ "$step_rc" == "fail" ]]; then
    overall=1
  fi
done
summarise_and_exit "$overall"
