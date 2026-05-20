import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { defineTool } from "../base.js";

// ── Anti-Fingerprinting ────────────────────────────────────────────
// Rotating User-Agent pool prevents adversarial sites from detecting
// and targeting Brainstorm agents specifically. Static "BrainstormCLI/0.1"
// was identified as a fingerprinting vector in the Agent Traps analysis.

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
];

let uaIndex = 0;
/**
 * Rotating User-Agent. Exported so other web-adjacent tools
 * (web_search in particular) can share the anti-fingerprinting
 * pool rather than each inventing their own static string.
 */
export function getNextUserAgent(): string {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

/** Standard browser-like headers to avoid fingerprinting. */
export function getBrowserHeaders(): Record<string, string> {
  return {
    "User-Agent": getNextUserAgent(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };
}

const MAX_REDIRECTS = 5;
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

interface FetchSafetyResult {
  ok: true;
  url: URL;
}

interface FetchSafetyBlock {
  ok: false;
  reason: string;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    METADATA_HOSTNAMES.has(normalized)
  );
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/(?:::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) {
    return isBlockedIpv4(mappedIpv4[1]);
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const [ipv4, ipv6] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);

  const addresses = [
    ...(ipv4.status === "fulfilled" ? ipv4.value : []),
    ...(ipv6.status === "fulfilled" ? ipv6.value : []),
  ];

  return addresses;
}

export async function assertPublicFetchUrl(
  rawUrl: string,
): Promise<FetchSafetyResult | FetchSafetyBlock> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http and https URLs are allowed" };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "URLs with embedded credentials are not allowed",
    };
  }

  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) {
    return {
      ok: false,
      reason: "loopback or metadata hostname is not allowed",
    };
  }

  if (isIP(hostname)) {
    return isBlockedIp(hostname)
      ? {
          ok: false,
          reason: "private, loopback, or reserved IP address is not allowed",
        }
      : { ok: true, url: parsed };
  }

  const addresses = await resolvePublicAddresses(hostname);
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: "hostname did not resolve to a public address",
    };
  }

  const blocked = addresses.find((address) => isBlockedIp(address));
  if (blocked) {
    return {
      ok: false,
      reason: `hostname resolves to blocked address ${blocked}`,
    };
  }

  return { ok: true, url: parsed };
}

async function fetchWithSafety(
  startUrl: string,
): Promise<{ response?: Response; finalUrl: string; error?: string }> {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const safety = await assertPublicFetchUrl(currentUrl);
    if (!safety.ok) {
      return { finalUrl: currentUrl, error: `Blocked URL: ${safety.reason}` };
    }

    const response = await fetch(safety.url, {
      signal: AbortSignal.timeout(10_000),
      headers: getBrowserHeaders(),
      redirect: "manual",
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: safety.url.toString() };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, finalUrl: safety.url.toString() };
    }

    currentUrl = new URL(location, safety.url).toString();
  }

  return {
    finalUrl: currentUrl,
    error: `Blocked URL: too many redirects (${MAX_REDIRECTS})`,
  };
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  description: "Fetch and return the content of a URL.",
  permission: "auto",
  inputSchema: z.object({
    url: z.string().describe("URL to fetch"),
    maxLength: z
      .number()
      .optional()
      .describe("Max response length in characters (default: 10000)"),
  }),
  async execute({ url, maxLength }) {
    try {
      const { response, finalUrl, error } = await fetchWithSafety(url);
      if (error || !response) return { error: error ?? "Fetch blocked", url };

      if (!response.ok)
        return {
          error: `HTTP ${response.status}: ${response.statusText}`,
          url: finalUrl,
        };
      const text = await response.text();
      const limit = maxLength ?? 10000;
      return {
        content: text.slice(0, limit),
        truncated: text.length > limit,
        contentType: response.headers.get("content-type") ?? "unknown",
        url: finalUrl,
      };
    } catch (err: any) {
      return { error: err.message, url };
    }
  },
});
