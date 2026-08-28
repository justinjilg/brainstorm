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

let availabilityCache: boolean | null = null;

/** True when the macOS `security` keychain tool is usable. */
export function keychainAvailable(): boolean {
  if (availabilityCache !== null) return availabilityCache;
  if (process.platform !== "darwin") {
    availabilityCache = false;
    return false;
  }
  try {
    execFileSync("security", ["help"], { timeout: 3000, stdio: "pipe" });
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

/**
 * Read a secret from the login keychain. Returns null if absent or on any
 * error (locked keychain, denied ACL, non-macOS).
 */
export function keychainRead(
  account: string,
  service = SERVICE,
): string | null {
  if (!keychainAvailable()) return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const value = out.toString("utf-8").replace(/\n$/, "");
    return value.length > 0 ? value : null;
  } catch {
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
    "security",
    ["add-generic-password", "-a", account, "-s", service, "-U", "-w"],
    {
      input: `${secret}\n${secret}\n`,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return res.status === 0;
}
