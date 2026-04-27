#!/usr/bin/env bash
# Verify (or print) checksums for already-built artifacts.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PKG_DIR}/artifacts"
if [[ ! -f checksums.txt ]]; then
  echo "no checksums.txt — run scripts/build.sh first" >&2
  exit 1
fi
sha256sum -c checksums.txt
