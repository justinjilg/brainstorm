/**
 * Content Sanitizer — strips dangerous content from web_fetch/web_search outputs.
 *
 * We don't use DOMPurify because we're not rendering HTML — we're preventing
 * instruction injection in text that feeds into an LLM prompt. Regex-based
 * stripping is sufficient for this threat model.
 *
 * Removes:
 *   - <script>, <style>, <iframe>, <object>, <embed>, <applet> tags and content
 *   - Event handler attributes (onclick, onerror, etc.)
 *   - javascript: and data: URLs
 *   - HTML comments (potential hidden instruction vectors)
 *   - Zero-width characters (steganographic hiding)
 *   - Base64-encoded blocks over 200 chars (potential payload hiding)
 *
 * Preserves:
 *   - Readable text content
 *   - Structural HTML tags (p, div, h1-h6, li, table, etc.)
 *   - Links (with href sanitized)
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("content-sanitizer");

export interface SanitizeResult {
  /** Sanitized content. */
  content: string;
  /** Number of elements stripped. */
  strippedCount: number;
  /** Categories of stripped content. */
  strippedCategories: string[];
  /** Whether the content was modified at all. */
  modified: boolean;
}

// ── Dangerous Tag Patterns ─────────────────────────────────────────

/** Tags whose entire content (including children) should be removed. */
const REMOVE_WITH_CONTENT = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "noscript",
  "template",
];

/** Build regex that matches opening tag through closing tag, including content. */
function buildTagRemovalRegex(tag: string): RegExp {
  return new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
}

// ── Attribute Patterns ─────────────────────────────────────────────

/** Event handler attributes. */
const EVENT_HANDLER_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** javascript: and data: URLs in attributes (quoted and unquoted). */
const DANGEROUS_URL_RE =
  /\s+(href|src|action|formaction)\s*=\s*(?:"(?:javascript|data|vbscript):[^"]*"|'(?:javascript|data|vbscript):[^']*'|(?:javascript|data|vbscript):[^\s>]*)/gi;

// ── Hidden Content Patterns ────────────────────────────────────────

/** HTML comments (can hide instructions). */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Zero-width characters used for steganographic hiding. */
const ZERO_WIDTH_RE =
  /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064]/g;

/** Large base64 blocks (potential payload hiding). */
const LARGE_BASE64_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;

// ── Sanitize ───────────────────────────────────────────────────────

/**
 * Sanitize HTML/text content from external sources.
 * Returns cleaned content safe for LLM context injection.
 */
export function sanitizeContent(raw: string): SanitizeResult {
  // Input size limit — prevent ReDoS/OOM on very large inputs
  const MAX_INPUT_SIZE = 1_000_000; // 1MB
  if (raw.length > MAX_INPUT_SIZE) {
    log.warn(
      { size: raw.length, limit: MAX_INPUT_SIZE },
      "Input exceeds sanitization size limit — truncating",
    );
    raw = raw.slice(0, MAX_INPUT_SIZE);
  }

  try {
    return _sanitizeContentUnsafe(raw);
  } catch (err) {
    // FAIL CLOSED: if sanitization crashes, return empty content
    log.error(
      { err, inputLength: raw.length },
      "Content sanitization crashed — returning empty content (fail-closed)",
    );
    return {
      content: "",
      strippedCount: 1,
      strippedCategories: ["sanitization-error"],
      modified: true,
    };
  }
}

function _sanitizeContentUnsafe(raw: string): SanitizeResult {
  let content = raw;
  let strippedCount = 0;
  const strippedCategories: string[] = [];

  // 1. Remove dangerous tags with all their content
  for (const tag of REMOVE_WITH_CONTENT) {
    const re = buildTagRemovalRegex(tag);
    const matches = content.match(re);
    if (matches && matches.length > 0) {
      strippedCount += matches.length;
      if (!strippedCategories.includes("dangerous-tags")) {
        strippedCategories.push("dangerous-tags");
      }
      content = content.replace(re, "");
    }
  }

  // 1b. Strip any remaining unclosed dangerous opening tags
  const unclosedTagRe = new RegExp(
    `<(${REMOVE_WITH_CONTENT.join("|")})\\b[^>]*>`,
    "gi",
  );
  const unclosedMatches = content.match(unclosedTagRe);
  if (unclosedMatches && unclosedMatches.length > 0) {
    strippedCount += unclosedMatches.length;
    if (!strippedCategories.includes("dangerous-tags")) {
      strippedCategories.push("dangerous-tags");
    }
    content = content.replace(unclosedTagRe, "");
  }

  // 2. Remove event handler attributes
  const eventMatches = content.match(EVENT_HANDLER_RE);
  if (eventMatches && eventMatches.length > 0) {
    strippedCount += eventMatches.length;
    strippedCategories.push("event-handlers");
    content = content.replace(EVENT_HANDLER_RE, "");
  }

  // 3. Remove dangerous URLs in attributes
  const urlMatches = content.match(DANGEROUS_URL_RE);
  if (urlMatches && urlMatches.length > 0) {
    strippedCount += urlMatches.length;
    strippedCategories.push("dangerous-urls");
    content = content.replace(DANGEROUS_URL_RE, "");
  }

  // 4. Remove HTML comments
  const commentMatches = content.match(HTML_COMMENT_RE);
  if (commentMatches && commentMatches.length > 0) {
    strippedCount += commentMatches.length;
    strippedCategories.push("html-comments");
    content = content.replace(HTML_COMMENT_RE, "");
  }

  // 5. Remove zero-width characters
  const zwMatches = content.match(ZERO_WIDTH_RE);
  if (zwMatches && zwMatches.length > 0) {
    strippedCount += zwMatches.length;
    strippedCategories.push("zero-width-chars");
    content = content.replace(ZERO_WIDTH_RE, "");
  }

  // 6. Replace large base64 blocks with placeholder
  const b64Matches = content.match(LARGE_BASE64_RE);
  if (b64Matches && b64Matches.length > 0) {
    strippedCount += b64Matches.length;
    strippedCategories.push("large-base64");
    content = content.replace(LARGE_BASE64_RE, "[base64-content-removed]");
  }

  const modified = content !== raw;

  if (modified) {
    log.warn(
      { strippedCount, categories: strippedCategories },
      "Content sanitized — dangerous elements stripped",
    );
  }

  return { content, strippedCount, strippedCategories, modified };
}

/**
 * Extract readable text from HTML, stripping all tags.
 * Use when you want plain text, not sanitized HTML.
 */
export function extractText(html: string): string {
  // Decode HTML entities FIRST — before sanitization.
  // If we decode after, &lt;script&gt; becomes <script> post-sanitize.
  let decoded = html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Then sanitize the decoded content
  const { content } = sanitizeContent(decoded);

  // Strip remaining HTML tags, keeping text content
  let text = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}
