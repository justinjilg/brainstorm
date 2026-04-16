/**
 * Safely encode a single URL path segment for connector API calls.
 *
 * Rejects inputs that look like path-traversal or multi-segment injection
 * (`..`, `/`, `\`, NUL, control chars) before encoding. Connectors take
 * IDs from LLM tool callers and must never let a malformed ID reshape the
 * URL — e.g. `device_id = "../../admin/keys"` would otherwise reach
 * arbitrary admin endpoints under the trusted API key.
 *
 * Use this for *path segments*. For query-string values, continue using
 * encodeURIComponent directly — multi-segment-style attacks don't apply
 * there because the query string isn't structural.
 */
export function encodePathSegment(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("encodePathSegment: empty or non-string input");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(
      `encodePathSegment: path separator in id (${JSON.stringify(value)})`,
    );
  }
  if (value.includes("..")) {
    throw new Error(
      `encodePathSegment: traversal sequence in id (${JSON.stringify(value)})`,
    );
  }
  // Reject NUL and other C0 control bytes that some HTTP stacks mishandle.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `encodePathSegment: control character in id (code ${code})`,
      );
    }
  }
  return encodeURIComponent(value);
}
