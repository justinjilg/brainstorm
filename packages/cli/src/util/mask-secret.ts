/**
 * Render a secret in a form safe to print to a terminal, scrollback, or log.
 *
 * Returns only the length — no prefix, no suffix, no partial characters.
 * The previous approach of echoing the first 8 characters leaked the
 * provider-identifying high-entropy segment of modern API keys (e.g.
 * `sk-ant-…`, `sk_live_…`, `ghp_…`) which is enough for an observer to
 * classify what the secret unlocks even when the tail is masked.
 *
 * Callers that genuinely need the plaintext should take an explicit
 * `--reveal` flag and print the raw value; this helper should never be
 * asked to return anything partial.
 */
export function maskSecret(value: string): string {
  if (!value) return "[redacted, 0 chars]";
  return `[redacted, ${value.length} chars]`;
}
