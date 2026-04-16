/**
 * MCP OAuth — client_credentials grant for MCP server authentication.
 *
 * Caches tokens with auto-refresh 60s before expiry.
 * Supports 1Password op:// URIs for credential resolution.
 */

export interface OAuthConfig {
  type: "oauth";
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes?: string[];
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const inflightRequests = new Map<string, Promise<string>>();
const REFRESH_BUFFER_MS = 60_000; // Refresh 60s before expiry

/**
 * Get a valid OAuth access token, fetching or refreshing as needed.
 * Concurrent calls for the same key coalesce into a single request.
 */
export async function getOAuthToken(config: OAuthConfig): Promise<string> {
  const cacheKey = `${config.tokenUrl}:${config.clientId}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  // Evict expired tokens to prevent unbounded cache growth
  if (cached) tokenCache.delete(cacheKey);

  const inflight = inflightRequests.get(cacheKey);
  if (inflight) return inflight;

  const promise = fetchOAuthToken(config, cacheKey);
  inflightRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

async function fetchOAuthToken(
  config: OAuthConfig,
  cacheKey: string,
): Promise<string> {
  const clientId = await resolveSecret(config.clientId);
  const clientSecret = await resolveSecret(config.clientSecret);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    ...(config.scopes ? { scope: config.scopes.join(" ") } : {}),
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `OAuth token request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
  };

  const expiresIn = data.expires_in ?? 3600;
  const token: CachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  tokenCache.set(cacheKey, token);
  return token.accessToken;
}

/**
 * Resolve a secret value — supports 1Password op:// URIs.
 */
async function resolveSecret(value: string): Promise<string> {
  if (!value.startsWith("op://")) return value;

  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("op", ["read", value], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`Failed to resolve 1Password secret: ${value}`);
  }
}
