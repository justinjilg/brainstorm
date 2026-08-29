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

/**
 * Timeout for every `security` invocation. 10s default; override with
 * BRAINSTORM_KEYCHAIN_TIMEOUT_MS for machines whose keychain UI/unlock is slow.
 */
function keychainTimeoutMs(): number {
  const raw = Number(process.env.BRAINSTORM_KEYCHAIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

// Availability is cached, but re-probed after a TTL so a keychain that becomes
// usable mid-run (e.g. the user unlocks it later) is picked up without an
// explicit reset. resetKeychainAvailability() forces an immediate re-probe.
const AVAILABILITY_TTL_MS = 60000;
let availabilityCheckedAt = 0;

let availabilityCache: boolean | null = null;

/**
 * True when the macOS `security` keychain tool is usable. Cached for the
 * process lifetime; call `resetKeychainAvailability()` to re-probe if the
 * environment can change under a long-running daemon (e.g. the keychain is
 * unlocked later). Non-darwin and probe failures log once so "vault falls back
 * to env" is diagnosable rather than silent.
 */
export function keychainAvailable(): boolean {
  const now = Date.now();
  if (
    availabilityCache !== null &&
    now - availabilityCheckedAt < AVAILABILITY_TTL_MS
  )
    return availabilityCache;
  availabilityCheckedAt = now;
  if (process.platform !== "darwin") {
    logOnce(
      `[keychain] unavailable on ${process.platform} — falling back to env/prompt for the vault password`,
    );
    availabilityCache = false;
    return false;
  }
  try {
    execFileSync(SECURITY_BIN, ["help"], {
      timeout: keychainTimeoutMs(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    availabilityCache = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    logOnce(`[keychain] ${SECURITY_BIN} not usable: ${msg}`);
    availabilityCache = false;
  }
  return availabilityCache;
}

/** Clear the cached availability so the next call re-probes immediately. */
export function resetKeychainAvailability(): void {
  availabilityCache = null;
  availabilityCheckedAt = 0;
}

// De-duplicate identical stderr diagnostics so a persistently locked keychain
// (probed on a TTL) can't flood the log with the same line every re-probe.
const seenLogs = new Set<string>();
function logOnce(msg: string): void {
  if (seenLogs.has(msg)) return;
  if (seenLogs.size > 200) seenLogs.clear(); // bound memory
  seenLogs.add(msg);
  process.stderr.write(msg + "\n");
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
      { timeout: keychainTimeoutMs(), stdio: ["pipe", "pipe", "pipe"] },
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
    const e = err as {
      status?: number;
      code?: string;
      signal?: string;
      stderr?: Buffer | string;
    };
    if (e?.status !== 44) {
      const detail = e?.stderr ? ` (${String(e.stderr).trim()})` : "";
      const cause =
        e?.code === "ETIMEDOUT" || e?.signal
          ? `timed out (${e.code ?? e.signal}) — keychain may be prompting or locked`
          : `exit ${e?.status ?? "?"} — keychain may be locked or access denied`;
      logOnce(
        `[keychain] read failed for ${service}/${account}: ${cause}${detail}`,
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
  // The secret is delivered over the type/retype stdin prompt as
  // "<secret>\n<secret>\n"; a newline INSIDE the secret would desync that
  // parsing (the tool would read a truncated first line, then mismatch on
  // retype). Reject rather than silently store a corrupted value.
  if (secret.includes("\n") || secret.includes("\r")) {
    logOnce(
      `[keychain] refusing to write ${service}/${account}: secret contains a newline`,
    );
    return false;
  }
  const res = spawnSync(
    SECURITY_BIN,
    ["add-generic-password", "-a", account, "-s", service, "-U", "-w"],
    {
      input: `${secret}\n${secret}\n`,
      timeout: keychainTimeoutMs(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (res.status !== 0) {
    // Surface WHY the write failed — symmetric with keychainRead — so a hung
    // (timeout), un-spawnable (ENOENT), or rejected write is diagnosable
    // instead of a bare "false".
    const detail = res.stderr ? ` (${String(res.stderr).trim()})` : "";
    const cause = res.error
      ? `${(res.error as { code?: string }).code ?? res.error.message}`
      : res.signal
        ? `killed by ${res.signal} (timed out?)`
        : `exit ${res.status}`;
    logOnce(
      `[keychain] write failed for ${service}/${account}: ${cause}${detail}`,
    );
    return false;
  }
  return true;
}
