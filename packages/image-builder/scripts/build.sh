#!/usr/bin/env bash
# Brainstorm endpoint sandbox image builder (P3.4) — driver script.
#
# Usage:
#   scripts/build.sh                 # full build
#   scripts/build.sh --target rootfs # rootfs only (still needs Docker)
#   scripts/build.sh --target kernel # kernel + initramfs only
#   scripts/build.sh --no-extract    # skip artifact extraction
#
# Behavior on Darwin:
#   - If Docker (Desktop) is available, runs the build inside Docker.
#   - If not, prints a clear "skipped" message and exits 0.
#
# Behavior on Linux:
#   - Uses Docker if available, else prints a "needs Docker" message and exits 0.
#
# Exit codes:
#   0  build OK, OR build skipped on a platform that can't run it
#   2  build attempted but failed
#   3  invalid arguments

set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS_DIR="${PKG_DIR}/artifacts"
DOCKERFILE="${PKG_DIR}/build/Dockerfile"
IMAGE_TAG="brainstorm/image-builder:dev"

TARGET="all"
EXTRACT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --no-extract)
      EXTRACT=0
      shift
      ;;
    -h|--help)
      sed -n '2,18p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "build.sh: unknown arg: $1" >&2
      exit 3
      ;;
  esac
done

case "${TARGET}" in
  all|rootfs|kernel|vsock-init) ;;
  *)
    echo "build.sh: --target must be one of: all rootfs kernel vsock-init" >&2
    exit 3
    ;;
esac

mkdir -p "${ARTIFACTS_DIR}"

OS="$(uname -s)"
echo "[bsm-image-builder] host OS: ${OS}"
echo "[bsm-image-builder] target: ${TARGET}"
echo "[bsm-image-builder] artifacts: ${ARTIFACTS_DIR}"

# ---------------------------------------------------------------------------
# Pre-flight: Docker
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<EOF
[bsm-image-builder] Docker not found in PATH.

This package builds a Linux kernel + rootfs and therefore requires either:
  (a) a Linux host with the kernel headers + e2fsprogs, OR
  (b) any host with Docker / Docker Desktop installed.

On macOS: install Docker Desktop (https://docs.docker.com/desktop/install/mac/)
or run this build on the Linux relay/CI host.

Skipping build. Exit 0 so this is not a CI failure on platforms that can't run it.
EOF
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  cat >&2 <<EOF
[bsm-image-builder] Docker is installed but the daemon is not reachable.
  - On macOS: open Docker Desktop and wait for it to finish starting.
  - On Linux: 'sudo systemctl start docker' or check group membership.

Skipping build (exit 0).
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "[bsm-image-builder] building image: ${IMAGE_TAG}"
DOCKER_BUILDKIT=1 docker build \
  --progress=plain \
  -f "${DOCKERFILE}" \
  -t "${IMAGE_TAG}" \
  "${PKG_DIR}" \
  || {
    echo "[bsm-image-builder] docker build FAILED" >&2
    exit 2
  }

echo "[bsm-image-builder] image built OK"

if [[ "${EXTRACT}" -eq 0 ]]; then
  echo "[bsm-image-builder] --no-extract set; leaving artifacts in image"
  exit 0
fi

# ---------------------------------------------------------------------------
# Extract artifacts: spin up a throwaway container and `docker cp` /out.
# ---------------------------------------------------------------------------
CID="$(docker create "${IMAGE_TAG}")"
trap 'docker rm -f "${CID}" >/dev/null 2>&1 || true' EXIT

echo "[bsm-image-builder] extracting artifacts from container ${CID}"

case "${TARGET}" in
  all)
    files=(bsm-sandbox-rootfs.tar bsm-sandbox-rootfs.img bsm-sandbox-kernel bsm-sandbox-initramfs vsock-init.bin checksums.txt)
    ;;
  rootfs)
    files=(bsm-sandbox-rootfs.tar bsm-sandbox-rootfs.img checksums.txt)
    ;;
  kernel)
    files=(bsm-sandbox-kernel bsm-sandbox-initramfs checksums.txt)
    ;;
  vsock-init)
    files=(vsock-init.bin checksums.txt)
    ;;
esac

for f in "${files[@]}"; do
  docker cp "${CID}:/out/${f}" "${ARTIFACTS_DIR}/${f}"
  echo "  -> ${ARTIFACTS_DIR}/${f}"
done

echo
echo "[bsm-image-builder] DONE."
echo "Artifacts:"
ls -lh "${ARTIFACTS_DIR}"
echo
echo "Checksums:"
cat "${ARTIFACTS_DIR}/checksums.txt" 2>/dev/null || true
