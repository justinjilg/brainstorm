// SHA-256 hashing for the rootfs CoW overlay file.
//
// One of the three reset-verification sources (per threat model §5.1) is
// the filesystem-hash of the rootfs's copy-on-write overlay. After a
// clean snapshot revert the overlay should be empty (or contain only
// well-known seed bytes), so its SHA-256 is stable and equal to the
// install-time baseline.
//
// Why a separate module: tests need to inject a fake hasher to drive
// "fs_hash matches baseline" vs "fs_hash diverges from baseline" cases
// without writing real disk overlay files.
//
// Honesty: this module has been exercised against the default streaming
// hasher (Node's built-in `crypto.createHash`) and against an injected
// fake in unit tests. It has NOT been pointed at a real CHV CoW overlay
// file in this checkout. The integration runner is responsible for
// confirming that the file CHV writes to during execution does in fact
// settle to a deterministic state after `snapshot` revert.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { SandboxResetError } from "../errors.js";

/**
 * Compute a stable hash for a file path. Default returns SHA-256 in the
 * `sha256:<hex>` form to match the protocol §13 baseline format.
 *
 * Tests inject a fake `HashFileFn` so the divergence vs match cases can
 * be driven by canned values without writing real overlays.
 */
export type HashFileFn = (path: string) => Promise<string>;

/**
 * Default streaming hasher: opens the file, pipes through SHA-256,
 * returns `sha256:<hex>`. Throws `SandboxResetError` if the file cannot
 * be read — divergence from "baseline configured but unreadable post
 * reset" is by definition a halt-worthy event.
 */
export const defaultHashFile: HashFileFn = async (path) => {
  try {
    await stat(path);
  } catch (e) {
    throw new SandboxResetError(
      `rootfs overlay file unreadable at ${path}: ${(e as Error).message}`,
      e,
    );
  }
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
    stream.on("error", (err) =>
      reject(
        new SandboxResetError(
          `failed to stream rootfs overlay at ${path}: ${err.message}`,
          err,
        ),
      ),
    );
  });
};

/**
 * Sentinel returned when no `fs_hash` baseline is configured. The
 * verification path treats this as "not configured" (soft pass with a
 * marker), distinct from a real divergence.
 */
export const FS_HASH_NOT_CONFIGURED = "sha256:not-configured";
