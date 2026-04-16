import {
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  /** File mode (e.g., 0o600 for private files). */
  mode?: number;
  /** Skip fsync. Faster but loses the crash-durability guarantee. */
  skipFsync?: boolean;
}

/**
 * Write `data` to `path` atomically and concurrent-safely.
 *
 * Multiple processes may call this function with the same `path` and
 * different `data` — each temp file is uniquely named by pid + UUID,
 * so neither truncates the other. The final `rename` is atomic on
 * POSIX filesystems (including APFS and ext4) when source and target
 * are on the same filesystem. The winner of the race is whichever
 * `rename` ran last.
 *
 * The parent directory must already exist.
 */
export function atomicWriteFile(
  path: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const tempPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;

  try {
    writeFileSync(
      tempPath,
      data,
      opts.mode !== undefined ? { mode: opts.mode } : undefined,
    );

    if (!opts.skipFsync) {
      const fd = openSync(tempPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Temp may not exist if writeFileSync never succeeded; ignore.
    }
    throw err;
  }
}
