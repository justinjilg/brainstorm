# syntax=docker/dockerfile:1.6
#
# Brainstorm endpoint sandbox image builder (P3.4).
#
# Inputs:
#   - vsock-init/ Go source (build context root must be packages/image-builder/)
#
# Outputs (written to /out inside the image; extracted by scripts/build.sh):
#   - /out/bsm-sandbox-rootfs.tar    -- rootfs tarball (pre-squashfs)
#   - /out/bsm-sandbox-rootfs.img    -- ext4 rootfs (loopback, ~64 MiB)
#   - /out/bsm-sandbox-kernel        -- Alpine virt kernel (vmlinuz-virt)
#   - /out/bsm-sandbox-initramfs     -- Alpine virt initramfs (initramfs-virt)
#   - /out/checksums.txt             -- SHA-256 over each artifact
#
# Strategy:
#   1. Stage `vsockbuild`: compile vsock-init as a static Linux/amd64 binary.
#   2. Stage `rootfsbuild`: assemble a minimal Alpine 3.20 rootfs containing
#      busybox + the MVP tool whitelist (echo, whoami, uname, cat, ls, env, sh)
#      + the vsock-init binary as /sbin/init.
#   3. Stage `pkg`: pull the Alpine `linux-virt` package (kernel + initramfs)
#      so we ship a kernel that boots cleanly under Cloud Hypervisor (no
#      modules required for the rootfs path) and Apple VF (which can use the
#      same vmlinuz on Sonoma+).
#   4. Stage `final`: collect everything into /out and produce checksums.
#
# What's stubbed (see README "what's stubbed vs what's real"):
#   - The kernel is Alpine's stock virt build, NOT a custom-stripped kernel.
#     Production should re-build with CONFIG_VSOCK=y / CONFIG_VIRTIO_VSOCK=y
#     verified, modules trimmed, and a baseline-hashed reproducible build.
#   - We produce ext4 (not squashfs); CHV/VF both accept both, but squashfs
#     is preferable for read-only enforcement.
#   - Reset machinery (P3.2a/b) is not exercised by this build.
#
# Reproducibility note:
#   We pin Alpine 3.20 + Go 1.22-alpine. SOURCE_DATE_EPOCH is exported so the
#   tar/ext4 timestamps are deterministic enough for hash comparison across
#   builds on the same host. Bit-for-bit reproducibility across hosts is a
#   post-MVP goal (R4 / post-MVP backlog: "Reproducible image builds with
#   signature verification").

ARG ALPINE_VERSION=3.20
ARG GO_VERSION=1.22

# ---------------------------------------------------------------------------
# Stage 1: build the vsock-init binary
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS vsockbuild
ARG TARGETARCH
ARG TARGETOS

WORKDIR /src
COPY vsock-init/go.mod vsock-init/go.sum* ./
# go.sum may not exist on first run; tolerate that.
RUN go mod download || true
COPY vsock-init/ ./

# Static, stripped, deterministic binary. CGO disabled so we don't drag glibc
# into a musl-based rootfs. Arch matches the target stage so the binary works
# under whichever VMM the consumer boots (CHV is x86_64-only today; VF on
# Apple Silicon needs arm64).
ENV CGO_ENABLED=0
RUN GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go mod tidy && \
    GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/vsock-init . && \
    ls -la /out/vsock-init

# ---------------------------------------------------------------------------
# Stage 2: assemble the rootfs
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS rootfsbuild

# Tools we need on the *builder* (not the rootfs) to assemble the image.
RUN apk add --no-cache \
        e2fsprogs \
        coreutils \
        tar \
        xz \
        gzip

# Build a fresh /rootfs by installing the minimal-Alpine package set into it
# via apk's --root flag. This gives us busybox (echo/cat/ls/sh/env/uname/whoami)
# without dragging in apk-tools, dev headers, etc.
ARG ALPINE_VERSION
RUN mkdir -p /rootfs/etc/apk/keys && \
    cp /etc/apk/keys/*.rsa.pub /rootfs/etc/apk/keys/ && \
    apk add --no-cache --root /rootfs --initdb \
        --keys-dir /etc/apk/keys \
        --repository "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/main/" \
        alpine-baselayout \
        busybox \
        musl \
        linux-virt
# linux-virt installs the kernel modules (including vsock + virtio-vsock)
# under /lib/modules/<kver>/. The in-guest vsock-init modprobes them at
# startup so /dev/vsock exists before vsock.Listen runs. Without this,
# busybox modprobe fails with "can't change directory to '/lib/modules'"
# (caught on first-light run #6 by 0bz7aztr).

# Minimal /etc/hostname, /etc/resolv.conf so processes that touch them don't
# crash. Networking is host-mediated per plan §3 (D21: agent-proxied egress);
# the guest itself does not resolve DNS.
RUN echo bsm-sandbox > /rootfs/etc/hostname && \
    echo "# brainstorm sandbox: no in-guest DNS by design" > /rootfs/etc/resolv.conf

# Alpine's busybox package installs /rootfs/sbin/init as a symlink to
# /bin/busybox. Docker COPY follows destination symlinks and would overwrite
# the *builder's* /bin/busybox (which is what /bin/sh resolves to in the
# alpine image), breaking every subsequent RUN with confusing exec errors.
# Delete the symlink first, then COPY into a real path.
RUN rm -f /rootfs/sbin/init
COPY --from=vsockbuild --chmod=0755 /out/vsock-init /rootfs/sbin/init

# Deterministic timestamps for tar (passed via --mtime below). We deliberately
# do NOT walk /rootfs to touch every file: on Darwin/aarch64 Docker Desktop
# 29.x, `find -exec touch` and even `xargs touch` reproducibly trigger an
# unwanted exec of /rootfs/sbin/init by some interaction with binfmt or
# busybox triggers — likely qemu-user-static probing the ELF. Per-file mtime
# bit-reproducibility is a post-MVP concern (see README TODOs).
ARG SOURCE_DATE_EPOCH=1714000000

# Produce a tarball (easy to inspect / extract).
RUN cd /rootfs && \
    tar --sort=name \
        --owner=0 --group=0 --numeric-owner \
        --mtime="@${SOURCE_DATE_EPOCH}" \
        -cf /tmp/bsm-sandbox-rootfs.tar .

# Produce an ext4 image. 64 MiB is enough headroom for the MVP tool set.
RUN dd if=/dev/zero of=/tmp/bsm-sandbox-rootfs.img bs=1M count=256 status=none && \
    mkfs.ext4 -F -L bsm-rootfs -d /rootfs /tmp/bsm-sandbox-rootfs.img
# Why 256 MiB: linux-virt brings ~55 MiB of installed packages, which after
# inode + journal + directory overhead doesn't fit a 64 MiB ext4 image
# (caught by 0bz7aztr on first-light run #7 with mke2fs "Could not allocate
# block ... while writing file tcp_bbr.ko.gz"). 256 MiB is comfortable
# headroom; a follow-up should strip /lib/modules down to just vsock +
# virtio-blk + ext4 deps and shrink back to a tighter image — minimal
# rootfs is a §G2/G4 attack-surface property of the threat model, not just
# an ergonomic concern.

# ---------------------------------------------------------------------------
# Stage 3: pull a kernel + initramfs
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS pkg

RUN apk add --no-cache linux-virt
# linux-virt installs to /boot. Names are versioned (e.g. vmlinuz-virt); we
# normalize to stable names.
RUN cp /boot/vmlinuz-virt /tmp/bsm-sandbox-kernel && \
    cp /boot/initramfs-virt /tmp/bsm-sandbox-initramfs

# ---------------------------------------------------------------------------
# Stage 4: collect outputs + checksums
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS final

RUN apk add --no-cache coreutils
WORKDIR /out

COPY --from=rootfsbuild /tmp/bsm-sandbox-rootfs.tar     /out/bsm-sandbox-rootfs.tar
COPY --from=rootfsbuild /tmp/bsm-sandbox-rootfs.img     /out/bsm-sandbox-rootfs.img
COPY --from=pkg         /tmp/bsm-sandbox-kernel         /out/bsm-sandbox-kernel
COPY --from=pkg         /tmp/bsm-sandbox-initramfs      /out/bsm-sandbox-initramfs
COPY --from=vsockbuild  /out/vsock-init                 /out/vsock-init.bin

RUN cd /out && \
    sha256sum \
        bsm-sandbox-rootfs.tar \
        bsm-sandbox-rootfs.img \
        bsm-sandbox-kernel \
        bsm-sandbox-initramfs \
        vsock-init.bin \
    > checksums.txt && \
    cat checksums.txt

CMD ["sh", "-c", "echo 'Image build complete. Artifacts in /out:' && ls -la /out && echo && cat /out/checksums.txt"]
