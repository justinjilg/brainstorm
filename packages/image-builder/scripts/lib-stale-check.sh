#!/usr/bin/env bash
# image_artifacts_stale REPO_ROOT
#
# Returns 0 (true) if the produced image-builder artifacts are STALE
# relative to their inputs — any file under
# `packages/image-builder/{vsock-init/, build/, scripts/build.sh,
# scripts/checksums.sh}` is newer than the oldest produced artifact.
# Returns 1 (false) if artifacts are either missing entirely (caller
# should treat that as "needs build" too) or all newer than every
# input.
#
# Why this exists: 0bz7aztr's run-6 caught a silent staleness gap in
# our validation harness. The exists-check on the .img files was
# letting OLD vsock-init binaries run against fresh source — which
# masked both fixes-not-applying AND would mask regressions-not-caught.
# Both directions are bad; the second is invisible, so we always check.
#
# Usage:
#   . packages/image-builder/scripts/lib-stale-check.sh
#   if image_artifacts_stale "$(pwd)" || [[ ! -f "$ROOTFS" ]]; then
#       bash packages/image-builder/scripts/build.sh
#   fi

image_artifacts_stale() {
    local repo_root="${1:-$(pwd)}"
    local artifacts="$repo_root/packages/image-builder/artifacts"
    local rootfs_img="$artifacts/bsm-sandbox-rootfs.img"

    # Missing artifacts → caller should rebuild. Returning false here
    # because "stale" is specifically about source-newer-than-artifact.
    # Caller is expected to also test [[ -f $ROOTFS ]] separately.
    [[ -f "$rootfs_img" ]] || return 1

    local rootfs_mtime
    rootfs_mtime=$(stat -c %Y "$rootfs_img" 2>/dev/null \
                    || stat -f %m "$rootfs_img" 2>/dev/null \
                    || echo 0)

    # Walk every input directory + script, find max source mtime.
    local newest_source_mtime=0
    local input_paths=(
        "$repo_root/packages/image-builder/vsock-init"
        "$repo_root/packages/image-builder/build"
        "$repo_root/packages/image-builder/scripts/build.sh"
        "$repo_root/packages/image-builder/scripts/checksums.sh"
    )
    for p in "${input_paths[@]}"; do
        [[ -e "$p" ]] || continue
        local m
        # On Linux: -printf '%T@\n' gives epoch seconds; on macOS: stat -f %m
        m=$(find "$p" -type f -printf '%T@\n' 2>/dev/null \
            | sort -nr | head -1 | cut -d. -f1) || true
        if [[ -z "$m" ]]; then
            # macOS fallback
            m=$(find "$p" -type f -exec stat -f %m {} \; 2>/dev/null \
                | sort -nr | head -1) || true
        fi
        m="${m:-0}"
        if (( m > newest_source_mtime )); then
            newest_source_mtime=$m
        fi
    done

    if (( newest_source_mtime > rootfs_mtime )); then
        return 0  # stale: source newer
    fi
    return 1  # fresh
}
