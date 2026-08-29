import { execFileSync, spawnSync } from "node:child_process";

/**
 * macOS Keychain backend — stores the Brainstorm vault master password in the
 * OS keychain so the encrypted vault can auto-unlock headlessly (desktop app,
 * daemon) WITHOUT any third-party CLI like `op`. The keychain is the trust
 * anchor; the vault file stays AES-256-GCM encrypted at rest.
 *
 * Uses the built-in `security` tool — always present on macOS, no dependency.
 * On non-macOS platforms every call is a safe no-op / null so callers fall
 * back to env vars or an interactive prompt.
 */

const SERVICE = "com.brainstorm.vault";
// Absolute path so a rogue `security` earlier on PATH cannot be substituted.
const SECURITY_BIN = "/usr/bin/security";

let availabilityCache: boolean | null = null;

/** True when the macOS `security` keychain tool is usable. */
export function keychainAvailable(): boolean {
  if (availabilityCache !== null) return availabilityCache;
  if (process.platform !== "darwin") {
    availabilityCache = false;
    return false;
  }
  try {
    execFileSync(SECURITY_BIN, ["help"], { timeout: 10000, stdio: "pipe" });
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

/**
 * Read a secret from the login keychain. Returns null when the item is absent
 * (the common, expected case → exit 44) or on any other error (locked keychain,
 * denied ACL, non-macOS). "Not found" is not logged; genuine failures (a locked
 * keychain, a `security` crash) are surfaced to stderr so a broken keychain is
 * diagnosable instead of silently masquerading as "no password set".
 */
export function keychainRead(
  account: string,
  service = SERVICE,
): string | null {
  if (!keychainAvailable()) return null;
  try {
    const out = execFileSync(
      SECURITY_BIN,
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    );
    // A zero-exit means the item EXISTS: return its value even if empty, so a
    // deliberately-stored empty secret is distinct from "no such item" (which
    // is the caught exit-44 path below that returns null).
    return out.toString("utf-8").replace(/\n$/, "");
  } catch (err) {
    // `security` exits 44 when the item simply doesn't exist — expected, quiet.
    // Anything else is a real fault worth surfacing with its cause so a slow or
    // locked keychain isn't misread as "no password set": a timeout (the tool
    // hung, e.g. a UI unlock prompt) vs. a non-zero exit (locked / ACL denied).
    const e = err as { status?: number; code?: string; signal?: string };
    if (e?.status !== 44) {
      const cause =
        e?.code === "ETIMEDOUT" || e?.signal
          ? `timed out (${e.code ?? e.signal}) — keychain may be prompting or locked`
          : `exit ${e?.status ?? "?"} — keychain may be locked or access denied`;
      process.stderr.write(
        `[keychain] read failed for ${service}/${account}: ${cause}\n`,
      );
    }
    return null;
  }
}

/**
 * Write (create or replace) a secret in the login keychain. Returns true on
 * success. `-U` updates in place if the item already exists.
 *
 * The secret is fed via stdin, NOT as a `-w <value>` argument, so it never
 * appears in the process argument list (visible to `ps`/process monitors).
 * macOS `security -w` with no value prompts for the password twice
 * (type + retype); we satisfy both by writing "<secret>\n<secret>\n".
 */
export function keychainWrite(
  account: string,
  secret: string,
  service = SERVICE,
): boolean {
  if (!keychainAvailable()) return false;
  const res = spawnSync(
    SECURITY_BIN,
    ["add-generic-password", "-a", account, "-s", service, "-U", "-w"],
    {
      input: `${secret}\n${secret}\n`,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (res.status !== 0) {
    // Surface WHY the write failed — symmetric with keychainRead — so a hung
    // (timeout), un-spawnable (ENOENT), or rejected write is diagnosable
    // instead of a bare "false".
    const cause = res.error
      ? `${(res.error as { code?: string }).code ?? res.error.message}`
      : res.signal
        ? `killed by ${res.signal} (timed out?)`
        : `exit ${res.status}`;
    process.stderr.write(
      `[keychain] write failed for ${service}/${account}: ${cause}\n`,
    );
    return false;
  }
  return true;
}
