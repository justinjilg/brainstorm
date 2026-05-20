import { createHash } from "node:crypto";

const BR_KEY_RE = /\bbr_(?:live|test|sk)_[A-Za-z0-9_-]{16,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TRACEPARENT_RE = /\b00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}\b/gi;

export function sha256Short(value: string | undefined | null): string {
  if (!value) return "sha256:none";
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function redactString(value: string): string {
  return value
    .replace(BR_KEY_RE, "[redacted-br-key]")
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(TRACEPARENT_RE, "[redacted-traceparent]");
}

export function safeSnippet(value: string, maxLength = 180): string {
  const redacted = redactString(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}...`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("authorization") ||
    normalized.includes("token") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("email")
  );
}

function isMemoryLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("memory") ||
    normalized.includes("snippet") ||
    normalized.includes("context") ||
    normalized === "text" ||
    normalized === "content"
  );
}

export function redactForArtifact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactForArtifact(item));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
    } else if (typeof item === "string" && isMemoryLikeKey(key)) {
      out[key] = safeSnippet(item, 80);
    } else {
      out[key] = redactForArtifact(item);
    }
  }
  return out;
}
