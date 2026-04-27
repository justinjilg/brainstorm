#!/usr/bin/env bash
# CHV first-light driver. Run on a Linux x86_64 host with KVM, cloud-hypervisor,
# ch-remote, Node 22+, and Docker (for the image-builder).
#
# Steps:
#   1. Sanity-check the host (KVM, binaries, Node version)
#   2. Build @brainst0rm/sandbox + @brainst0rm/relay (deps) + @brainst0rm/image-builder
#   3. Run the image-builder Docker pipeline → produces kernel + rootfs.img
#   4. Run packages/sandbox/scripts/first-light.ts → boots a CHV VM, runs echo,
#      verifies state="ready" + exit_code=0
#   5. Captures full stdout/stderr to $LOG and prints last 80 lines + summary
#
# Usage (from monorepo root):
#   bash packages/sandbox/scripts/first-light.sh
#
# Override defaults via env:
#   FIRSTLIGHT_DIR=/var/lib/firstlight  (where logs + artifact paths land)

set -uo pipefail

FIRSTLIGHT_DIR="${FIRSTLIGHT_DIR:-/var/lib/firstlight}"
LOG="${FIRSTLIGHT_DIR}/first-light-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$FIRSTLIGHT_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "=== CHV first-light driver ==="
echo "host: $(hostname)  arch: $(uname -m)  kernel: $(uname -r)"
echo "log:  $LOG"
echo

# ---- 1. host sanity ----------------------------------------------------
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
# Ubuntu 24.04's docker.io lacks BuildKit; image-builder Dockerfile uses
# `# syntax=docker/dockerfile:1.6` so buildx is required.
if have docker && ! docker buildx version >/dev/null 2>&1; then
  echo "MISS docker buildx (apt-get install -y docker-buildx)"
  fail=1
fi
if [[ $fail -ne 0 ]]; then
  echo
  echo "host sanity FAILED — fix the above and re-run"
  exit 3
fi

# ---- 2. build TS packages ----------------------------------------------
echo
echo "=== build sandbox + deps ==="
cd "$(dirname "$0")/../../.."   # monorepo root
npm install --no-audit --no-fund
npx turbo run build --filter='@brainst0rm/sandbox' || { echo "sandbox build failed"; exit 4; }

# ---- 3. build images ---------------------------------------------------
echo
echo "=== build kernel + rootfs (image-builder) ==="
bash packages/image-builder/scripts/build.sh || { echo "image-builder failed"; exit 4; }

KERNEL="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-kernel"
INITRAMFS="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-initramfs"
ROOTFS="$(pwd)/packages/image-builder/artifacts/bsm-sandbox-rootfs.img"

if [[ ! -f "$KERNEL" || ! -f "$INITRAMFS" || ! -f "$ROOTFS" ]]; then
  echo "image artifacts missing after build:"
  ls -la packages/image-builder/artifacts/
  exit 4
fi

echo "kernel:    $KERNEL ($(stat -c%s "$KERNEL") bytes)"
echo "initramfs: $INITRAMFS ($(stat -c%s "$INITRAMFS") bytes)"
echo "rootfs:    $ROOTFS ($(stat -c%s "$ROOTFS") bytes)"

# ---- 4. boot + dispatch ------------------------------------------------
echo
echo "=== first-light: boot + echo dispatch ==="
export BSM_KERNEL="$KERNEL"
export BSM_INITRAMFS="$INITRAMFS"
export BSM_ROOTFS="$ROOTFS"
export BSM_VSOCK_SOCKET="${FIRSTLIGHT_DIR}/vsock.sock"
export BSM_API_SOCKET="${FIRSTLIGHT_DIR}/api.sock"
export BSM_GUEST_PORT="${BSM_GUEST_PORT:-52000}"

node packages/sandbox/dist/scripts/first-light.js
rc=$?

# ---- 5. summary --------------------------------------------------------
echo
echo "=== summary ==="
echo "exit code: $rc"
echo "log:       $LOG"
echo
echo "tail (last 80 lines):"
tail -n 80 "$LOG"
exit $rc
