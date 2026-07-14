/**
 * Secret Substitution Middleware — keeps secrets out of model context.
 *
 * Two-phase design because wrapToolCall is synchronous:
 *   Phase 1 (wrapToolCall): Scans tool args for $VAULT_* patterns and marks them
 *     via _vaultSubstitutions metadata for async resolution in the loop wrapper.
 *   Phase 2 (afterToolResult): Scrubs resolved secret values from tool outputs,
 *     replacing them with the original $VAULT_* placeholder.
 *
 * The actual async vault resolution (vault lookup + arg injection) happens in loop.ts
 * where async is already supported.
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareToolResult,
} from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("secret-substitution");

// ── Pattern Detection ─────────────────────────────────────────────

const VAULT_PATTERN = /\$VAULT_([A-Z0-9_]+)/g;

/** Recursively find all $VAULT_* patterns in an object tree. */
export function findVaultPatterns(obj: unknown): string[] {
  const names = new Set<string>();
  walk(obj, (s) => {
    let match: RegExpExecArray | null;
    VAULT_PATTERN.lastIndex = 0;
    while ((match = VAULT_PATTERN.exec(s)) !== null) {
      names.add(match[1]);
    }
  });
  return Array.from(names);
}

// ── Scrub Map Registry ────────────────────────────────────────────
// Module-level registry bridges the sync middleware ↔ async loop.ts gap.
// loop.ts calls setScrubMap() after resolving secrets, middleware's
// afterToolResult calls consumeScrubMap() to scrub output.

const _scrubMapRegistry = new Map<
  string,
  { map: Map<string, string>; createdAt: number }
>();
const SCRUB_MAP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Register a scrub map for a tool call ID (called from loop.ts). */
export function setScrubMap(
  callId: string,
  scrubMap: Map<string, string>,
): void {
  // Prune stale entries (fix #15: memory leak if afterToolResult never fires)
  const cutoff = Date.now() - SCRUB_MAP_TTL_MS;
  for (const [id, entry] of _scrubMapRegistry) {
    if (entry.createdAt < cutoff) _scrubMapRegistry.delete(id);
  }
  _scrubMapRegistry.set(callId, { map: scrubMap, createdAt: Date.now() });
}

/** Get and consume a scrub map (called from afterToolResult). */
export function consumeScrubMap(
  callId: string,
): Map<string, string> | undefined {
  const entry = _scrubMapRegistry.get(callId);
  if (entry) {
    _scrubMapRegistry.delete(callId);
    return entry.map;
  }
  return undefined;
}

// ── Substitution & Scrubbing ──────────────────────────────────────

/**
 * Build a scrub map from vault patterns and a resolver.
 * Returns: Map<resolvedValue, "$VAULT_NAME">
 */
export async function buildScrubMap(
  patterns: string[],
  resolver: (name: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const scrubMap = new Map<string, string>();
  for (const name of patterns) {
    const value = await resolver(name);
    if (value) {
      scrubMap.set(value, `$VAULT_${name}`);
    } else {
      log.debug({ key: name }, "Vault pattern unresolved — passing through");
    }
  }
  return scrubMap;
}

/**
 * Inject resolved values into tool args, replacing $VAULT_NAME → actual value.
 * Mutates the input object in place (called right before execute in loop.ts).
 */
export function injectSecrets(
  input: Record<string, unknown>,
  scrubMap: Map<string, string>,
): void {
  // Build reverse: "$VAULT_NAME" → resolvedValue. Sort by placeholder
  // length DESC so that when one placeholder is a prefix of another
  // (e.g. "$VAULT_AB" prefixes "$VAULT_ABCD"), the longer one is
  // substituted first. Otherwise: a string `"$VAULT_ABCD-more"`
  // would first have "$VAULT_AB" matched, leaving `"<valueAB>CD-more"`
  // and the ABCD placeholder would never fire — leak of the shorter
  // secret into what should have been the ABCD value.
  const sortedInjects: Array<[string, string]> = [];
  for (const [value, placeholder] of scrubMap) {
    sortedInjects.push([placeholder, value]);
  }
  sortedInjects.sort((a, b) => b[0].length - a[0].length);

  for (const key of Object.keys(input)) {
    if (key === "_vaultSubstitutions") continue;
    input[key] = transform(input[key], (s) => {
      let result = s;
      for (const [placeholder, value] of sortedInjects) {
        // Function-form — replaceAll with a string replacement
        // interprets $1/$&/$`/$' in `value` as regex specials.
        // `value` is a resolved SECRET: passwords often contain
        // literal `$1`, `$&`, etc., and corrupting those before
        // sending to a tool means auth fails silently (or worse,
        // a truncated value is used in an api request).
        const v = value;
        result = result.replaceAll(placeholder, () => v);
      }
      return result;
    });
  }
}

/**
 * Scrub resolved secret values from tool output, replacing with $VAULT_* placeholders.
 * scrubMap keys: resolvedValue, values: $VAULT_NAME
 */
export function scrubSecrets(
  obj: unknown,
  scrubMap: Map<string, string>,
): unknown {
  if (scrubMap.size === 0) return obj;
  // Sort secrets by length DESC — when two secret values share a
  // prefix (e.g., `abc` and `abcdef`), the longer one MUST be
  // replaced first, or a tool-output fragment like "abcdef" would
  // have its "abc" prefix replaced with the placeholder, leaving
  // "<$VAULT_SHORT>def" — leaking "def", the tail of the longer
  // secret, into the model context. Real scenario: rotating keys
  // where old and new share a random prefix; or secrets where one
  // is derived from the other (e.g., password + salt concatenation).
  const sortedEntries = [...scrubMap.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  return transform(obj, (s) => {
    let result = s;
    for (const [secret, placeholder] of sortedEntries) {
      // Only scrub secrets of meaningful length to avoid false positives
      if (secret.length >= 4) {
        result = result.replaceAll(secret, placeholder);
      }
    }
    return result;
  });
}

// ── Middleware ─────────────────────────────────────────────────────

export function createSecretSubstitutionMiddleware(): AgentMiddleware {
  return {
    name: "secret-substitution",

    wrapToolCall(call: MiddlewareToolCall): MiddlewareToolCall | void {
      const patterns = findVaultPatterns(call.input);
      if (patterns.length === 0) return;

      log.debug(
        { tool: call.name, patternCount: patterns.length },
        "Vault patterns detected in tool args",
      );

      return {
        ...call,
        input: {
          ...call.input,
          _vaultSubstitutions: patterns,
        },
      };
    },

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      const scrubMap = consumeScrubMap(result.toolCallId);
      if (!scrubMap || scrubMap.size === 0) return;

      return {
        ...result,
        output: scrubSecrets(result.output, scrubMap),
      };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Iterative object walk (explicit stack, no recursion) invoking `visitor`
 * on every string reachable via own-enumerable properties / array elements.
 *
 * Rewritten from recursion to an explicit stack so arbitrarily deep or
 * cyclic input cannot blow the call stack. A `seen` set guarantees each
 * object is visited exactly once, so cyclic graphs terminate. Reachability
 * is identical to the previous recursive version (Object.values / array
 * items only).
 */
function walk(obj: unknown, visitor: (s: string) => void): void {
  if (typeof obj === "string") {
    visitor(obj);
    return;
  }
  if (obj === null || typeof obj !== "object") return;

  const seen = new Set<object>([obj]);
  const stack: object[] = [obj];
  while (stack.length) {
    const src = stack.pop()!;
    const values = Array.isArray(src) ? src : Object.values(src);
    for (const value of values) {
      if (typeof value === "string") {
        visitor(value);
      } else if (value !== null && typeof value === "object") {
        if (seen.has(value)) continue;
        seen.add(value);
        stack.push(value);
      }
    }
  }
}

/**
 * Iterative structural clone (explicit stack, no recursion) that passes
 * every reachable string through `fn`.
 *
 * SECRET-SAFETY INVARIANT: there is NO depth limit and NO recursion, so a
 * million-deep tree cannot stack-overflow and no subtree is ever returned
 * unvisited — "every reachable string passes through fn" holds
 * unconditionally. Cyclic input terminates: the `seen` map records each
 * object's clone, so an aliased/cyclic reference points at the
 * already-being-scrubbed clone (never emitted unscrubbed) instead of
 * recursing forever. The stack is heap-allocated and bounded by tree size,
 * not depth.
 *
 * Non-plain objects (Date, Map, Set, class instances, Buffer) behave
 * exactly as the prior recursive code: only their own enumerable
 * string-keyed props are walked; Map/Set internal entries are not
 * enumerable and are not scrubbed (unchanged, intentional).
 */
function transform(obj: unknown, fn: (s: string) => string): unknown {
  if (typeof obj === "string") return fn(obj);
  if (obj === null || typeof obj !== "object") return obj;

  const rootClone: any = Array.isArray(obj) ? [] : {};
  const seen = new Map<object, unknown>([[obj, rootClone]]);
  const stack: Array<{ src: object; dst: any }> = [
    { src: obj, dst: rootClone },
  ];

  while (stack.length) {
    const { src, dst } = stack.pop()!;
    const entries: Iterable<[PropertyKey, unknown]> = Array.isArray(src)
      ? (src.entries() as Iterable<[PropertyKey, unknown]>)
      : Object.entries(src);
    for (const [key, value] of entries) {
      if (typeof value === "string") {
        dst[key] = fn(value);
      } else if (value !== null && typeof value === "object") {
        if (seen.has(value)) {
          dst[key] = seen.get(value);
        } else {
          const clone: any = Array.isArray(value) ? [] : {};
          seen.set(value, clone);
          dst[key] = clone;
          stack.push({ src: value, dst: clone });
        }
      } else {
        dst[key] = value;
      }
    }
  }
  return rootClone;
}
