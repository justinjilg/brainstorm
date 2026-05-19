/**
 * `brainstorm login` — OAuth 2.0 Device Authorization Grant (RFC 8628)
 * against the Brainstorm platform Keycloak.
 *
 * Plan reference: P1 / M4 of radiant-petting-kitten v0.3 (D12).
 *
 * Flow:
 *   1. POST /protocol/openid-connect/auth/device with client_id
 *      = brainstorm-cli → get user_code + verification_uri_complete
 *      + device_code + expires_in + interval
 *   2. Print user_code + verification URL; user visits, logs in, approves
 *   3. Poll POST /protocol/openid-connect/token every `interval` seconds
 *      with grant_type=urn:ietf:params:oauth:grant-type:device_code until
 *      either access_token returned, expired, or denied
 *   4. Persist {access_token, refresh_token, expires_at, did} to
 *      ~/.brainstorm/session (chmod 600); subsequent CLI commands read it
 *
 * Configurable via env (or sensible defaults):
 *   BRAINSTORM_AUTH_BASE   default https://auth.brainstorm.co
 *   BRAINSTORM_AUTH_REALM  default brainstorm
 *   BRAINSTORM_CLI_CLIENT_ID  default brainstorm-cli
 *
 * Session file format (JSON):
 *   {
 *     "access_token":  "eyJ...",
 *     "refresh_token": "eyJ...",
 *     "expires_at":    1779200000,
 *     "did":           "did:bvm:<tenant>:<user>",
 *     "sub":           "<user_uuid>",
 *     "email":         "<user_email>",
 *     "issuer":        "https://auth.brainstorm.co/realms/brainstorm"
 *   }
 *
 * Refresh isn't automatic in this command — `brainstorm a2a invoke` etc.
 * detect expiry and either prompt to re-login or use the refresh_token
 * via /token. That refresh helper lives in a sibling file imported by
 * each command (out of scope for this PR; lands as P1.5b).
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_AUTH_BASE = "https://auth.brainstorm.co";
const DEFAULT_REALM = "brainstorm";
const DEFAULT_CLIENT_ID = "brainstorm-cli";
const DEFAULT_SCOPE = "openid profile email";
// RFC 8628 §3.4 — polling interval should default to 5s if server omits.
const DEFAULT_POLL_INTERVAL_SEC = 5;
// Hard-cap on total wait so CI/scripts don't hang.
const DEFAULT_DEADLINE_SEC = 900;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

interface DeviceTokenError {
  error: string;
  error_description?: string;
}

interface LoginOptions {
  authBase?: string;
  realm?: string;
  clientId?: string;
  deadline?: number;
  json?: boolean;
}

function sessionPath(): string {
  return path.join(os.homedir(), ".brainstorm", "session");
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function startDeviceFlow(
  authBase: string,
  realm: string,
  clientId: string,
): Promise<DeviceCodeResponse> {
  const url = `${authBase.replace(/\/$/, "")}/realms/${realm}/protocol/openid-connect/auth/device`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope: DEFAULT_SCOPE,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`device flow init failed: HTTP ${res.status} — ${body}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForToken(
  authBase: string,
  realm: string,
  clientId: string,
  deviceCode: string,
  intervalSec: number,
  deadlineSec: number,
): Promise<TokenResponse> {
  const url = `${authBase.replace(/\/$/, "")}/realms/${realm}/protocol/openid-connect/token`;
  const deadline = Date.now() + deadlineSec * 1000;
  let interval = intervalSec;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCode,
      }).toString(),
    });

    if (res.ok) {
      return (await res.json()) as TokenResponse;
    }

    const errBody = (await res.json().catch(() => ({}))) as DeviceTokenError;
    switch (errBody.error) {
      case "authorization_pending":
        // User hasn't approved yet; keep polling.
        continue;
      case "slow_down":
        // Server asks us to slow down; bump interval by 5s per RFC 8628 §3.5.
        interval += 5;
        continue;
      case "expired_token":
        throw new Error("device code expired; restart `brainstorm login`");
      case "access_denied":
        throw new Error("login was denied by the user");
      default:
        throw new Error(
          `token endpoint error: ${errBody.error ?? "unknown"} — ${errBody.error_description ?? ""}`,
        );
    }
  }
  throw new Error(`login timed out after ${deadlineSec}s without approval`);
}

function persistSession(
  token: TokenResponse,
  issuer: string,
): {
  did?: string;
  sub?: string;
  email?: string;
} {
  const dir = path.dirname(sessionPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const claims = decodeJwtClaims(token.access_token) ?? {};
  const did =
    typeof claims["did"] === "string" ? (claims["did"] as string) : undefined;
  const sub =
    typeof claims["sub"] === "string" ? (claims["sub"] as string) : undefined;
  const email =
    typeof claims["email"] === "string"
      ? (claims["email"] as string)
      : undefined;

  const session = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    did,
    sub,
    email,
    issuer,
  };

  fs.writeFileSync(sessionPath(), JSON.stringify(session, null, 2), {
    mode: 0o600,
  });
  return { did, sub, email };
}

async function runLogin(opts: LoginOptions): Promise<void> {
  const authBase =
    opts.authBase ?? process.env.BRAINSTORM_AUTH_BASE ?? DEFAULT_AUTH_BASE;
  const realm =
    opts.realm ?? process.env.BRAINSTORM_AUTH_REALM ?? DEFAULT_REALM;
  const clientId =
    opts.clientId ?? process.env.BRAINSTORM_CLI_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const deadlineSec = opts.deadline ?? DEFAULT_DEADLINE_SEC;

  let devCode: DeviceCodeResponse;
  try {
    devCode = await startDeviceFlow(authBase, realm, clientId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.error(
        JSON.stringify(
          { error: "device_flow_init_failed", message: msg },
          null,
          2,
        ),
      );
    } else {
      console.error(`  ✗ ${msg}`);
    }
    process.exitCode = 2;
    return;
  }

  const visitUri =
    devCode.verification_uri_complete ?? devCode.verification_uri;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          user_code: devCode.user_code,
          verification_uri: devCode.verification_uri,
          verification_uri_complete: devCode.verification_uri_complete,
          expires_in: devCode.expires_in,
        },
        null,
        2,
      ),
    );
  } else {
    console.log();
    console.log(`  Visit this URL to authorize the Brainstorm CLI:`);
    console.log(`    ${visitUri}`);
    console.log();
    console.log(`  If the URL doesn't prefill your code, enter:`);
    console.log(`    ${devCode.user_code}`);
    console.log();
    console.log(
      `  Waiting for approval (up to ${Math.floor(deadlineSec / 60)} minutes)...`,
    );
  }

  let tokenResp: TokenResponse;
  try {
    tokenResp = await pollForToken(
      authBase,
      realm,
      clientId,
      devCode.device_code,
      devCode.interval ?? DEFAULT_POLL_INTERVAL_SEC,
      deadlineSec,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.error(
        JSON.stringify({ error: "token_poll_failed", message: msg }, null, 2),
      );
    } else {
      console.error(`  ✗ ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  const issuer = `${authBase.replace(/\/$/, "")}/realms/${realm}`;
  const { did, sub, email } = persistSession(tokenResp, issuer);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          session_path: sessionPath(),
          did,
          sub,
          email,
          expires_in: tokenResp.expires_in,
        },
        null,
        2,
      ),
    );
  } else {
    console.log();
    console.log(`  ✓ Logged in.`);
    if (email) console.log(`    email:        ${email}`);
    if (did) console.log(`    did:          ${did}`);
    console.log(`    session:      ${sessionPath()}`);
    console.log(`    expires:      ${tokenResp.expires_in}s from now`);
    console.log();
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in to the Brainstorm platform (device-code flow)")
    .option(
      "--auth-base <url>",
      "Keycloak base URL (default $BRAINSTORM_AUTH_BASE or https://auth.brainstorm.co)",
    )
    .option(
      "--realm <name>",
      "Keycloak realm (default $BRAINSTORM_AUTH_REALM or 'brainstorm')",
    )
    .option(
      "--client-id <id>",
      "OIDC client ID (default $BRAINSTORM_CLI_CLIENT_ID or 'brainstorm-cli')",
    )
    .option(
      "--deadline <seconds>",
      "Hard timeout for the login flow",
      (v) => parseInt(v, 10),
      DEFAULT_DEADLINE_SEC,
    )
    .option("--json", "Output JSON (no human-readable banner)")
    .action(async (opts: LoginOptions) => {
      try {
        await runLogin(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.error(
            JSON.stringify({ error: "login_failed", message: msg }, null, 2),
          );
        } else {
          console.error(`  ✗ brainstorm login failed: ${msg}`);
        }
        process.exitCode = 1;
      }
    });
}

// Exported for tests
export const __test = {
  decodeJwtClaims,
  sessionPath,
  startDeviceFlow,
  pollForToken,
  persistSession,
};
