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
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: getBrowserHeaders(),
        redirect: "follow",
      });
      if (!response.ok)
        return {
          error: `HTTP ${response.status}: ${response.statusText}`,
          url,
        };
      const text = await response.text();
      const limit = maxLength ?? 10000;
      return {
        content: text.slice(0, limit),
        truncated: text.length > limit,
        contentType: response.headers.get("content-type") ?? "unknown",
        url,
      };
    } catch (err: any) {
      return { error: err.message, url };
    }
  },
});
