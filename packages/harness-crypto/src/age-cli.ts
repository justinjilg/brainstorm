import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Subprocess bridge to the `age` and `age-keygen` CLI tools.
 *
 * Per spec PQC §3.3: the recommended primary file-encryption tool. Wiring
 * is done via `child_process.spawn` with array-form args (NEVER through
 * a shell) so user content can never escape into command-injection.
 *
 * Availability:
 *   - `isAgeAvailable()` — true when `age` is on $PATH
 *   - `isAgeKeygenAvailable()` — true when `age-keygen` is on $PATH
 *   - APIs that need either tool throw a clear error if missing rather
 *     than fake-success.
 */

let _ageCache: boolean | null = null;
let _ageKeygenCache: boolean | null = null;

export async function isAgeAvailable(): Promise<boolean> {
  if (_ageCache !== null) return _ageCache;
  _ageCache = await checkBinary("age");
  return _ageCache;
}

export async function isAgeKeygenAvailable(): Promise<boolean> {
  if (_ageKeygenCache !== null) return _ageKeygenCache;
  _ageKeygenCache = await checkBinary("age-keygen");
  return _ageKeygenCache;
}

/** Reset cached availability checks (used by tests when the env changes). */
export function _resetAgeAvailabilityCache(): void {
  _ageCache = null;
  _ageKeygenCache = null;
}

async function checkBinary(name: string): Promise<boolean> {
  // `which` on POSIX, `where` on Windows. spawn never invokes a shell.
  const which = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(which, [name]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Encrypt `plaintext` to one or more recipient public keys, write to
 * `outputPath`. Recipients are age public-key strings (`age1...` or
 * `age1pq1...`).
 *
 * Equivalent shell form: `age -e -r <r1> -r <r2> -o <outputPath>` with
 * stdin = plaintext.
 */
export async function ageEncryptToFile(opts: {
  plaintext: string | Buffer;
  recipients: string[];
  outputPath: string;
}): Promise<void> {
  if (!(await isAgeAvailable())) {
    throw new Error(
      "age binary not found on $PATH — install via `brew install age` (macOS) or your distro's package manager. See PQC §3.3 of the spec.",
    );
  }
  if (opts.recipients.length === 0) {
    throw new Error("ageEncryptToFile: at least one recipient required");
  }

  const args: string[] = ["-e", "-o", opts.outputPath];
  for (const r of opts.recipients) {
    args.push("-r", r);
  }

  return runWithStdin("age", args, opts.plaintext);
}

/**
 * Decrypt a file at `encryptedPath` using the secret key in `identityFile`,
 * return the plaintext as a string.
 *
 * Equivalent shell form: `age -d -i <identityFile> <encryptedPath>` with
 * stdout captured.
 */
export async function ageDecryptFile(opts: {
  encryptedPath: string;
  identityFile: string;
}): Promise<string> {
  if (!(await isAgeAvailable())) {
    throw new Error("age binary not found on $PATH");
  }
  if (!existsSync(opts.encryptedPath)) {
    throw new Error(`Encrypted file not found: ${opts.encryptedPath}`);
  }
  if (!existsSync(opts.identityFile)) {
    throw new Error(`Identity file not found: ${opts.identityFile}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("age", [
      "-d",
      "-i",
      opts.identityFile,
      opts.encryptedPath,
    ]);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `age decrypt exited ${code}: ${Buffer.concat(errChunks).toString("utf-8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
  });
}

/**
 * Generate a fresh age identity. By default produces an X25519 (classical)
 * identity; pass `pq: true` to produce a PQ-hybrid identity (`age1pq1...`)
 * via `age-keygen --pq` (age v1.3+).
 *
 * Returns both keys. Caller is responsible for storing the secret in the
 * vault; the public key gets added to recipient bundles.
 */
export async function ageKeygen(opts: { pq?: boolean } = {}): Promise<{
  public_key: string;
  secret_key: string;
}> {
  if (!(await isAgeKeygenAvailable())) {
    throw new Error(
      "age-keygen binary not found on $PATH — install via `brew install age` (macOS).",
    );
  }

  const args: string[] = [];
  if (opts.pq) args.push("--pq");

  return new Promise((resolve, reject) => {
    const child = spawn("age-keygen", args);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `age-keygen exited ${code}: ${Buffer.concat(stderrChunks).toString("utf-8")}`,
          ),
        );
        return;
      }
      // age-keygen output:
      //   # created: 2026-04-27T10:00:00Z
      //   # public key: age1abc...
      //   AGE-SECRET-KEY-1...
      const out = Buffer.concat(stdoutChunks).toString("utf-8");
      const lines = out.split("\n");
      const publicLine = lines.find((l) => l.startsWith("# public key:"));
      const secretLine = lines.find(
        (l) => l.startsWith("AGE-SECRET-KEY-") || l.startsWith("AGE-PLUGIN-"),
      );
      if (!publicLine || !secretLine) {
        reject(new Error(`age-keygen output unexpected: ${out.slice(0, 200)}`));
        return;
      }
      const public_key = publicLine.slice("# public key:".length).trim();
      resolve({ public_key, secret_key: secretLine.trim() });
    });
  });
}

function runWithStdin(
  bin: string,
  args: string[],
  stdin: string | Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    const errChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${bin} exited ${code}: ${Buffer.concat(errChunks).toString("utf-8")}`,
          ),
        );
        return;
      }
      resolve();
    });
    child.stdin.end(typeof stdin === "string" ? Buffer.from(stdin) : stdin);
  });
}
