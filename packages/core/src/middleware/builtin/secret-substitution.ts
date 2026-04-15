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

const _scrubMapRegistry = new Map<string, Map<string, string>>();

/** Register a scrub map for a tool call ID (called from loop.ts). */
export function setScrubMap(
  callId: string,
  scrubMap: Map<string, string>,
): void {
  _scrubMapRegistry.set(callId, scrubMap);
}

/** Get and consume a scrub map (called from afterToolResult). */
export function consumeScrubMap(
  callId: string,
): Map<string, string> | undefined {
  const map = _scrubMapRegistry.get(callId);
  if (map) _scrubMapRegistry.delete(callId);
  return map;
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
  // Build reverse: "$VAULT_NAME" → resolvedValue
  const injectMap = new Map<string, string>();
  for (const [value, placeholder] of scrubMap) {
    injectMap.set(placeholder, value);
  }
  for (const key of Object.keys(input)) {
    if (key === "_vaultSubstitutions") continue;
    input[key] = transform(input[key], (s) => {
      let result = s;
      for (const [placeholder, value] of injectMap) {
        result = result.replaceAll(placeholder, value);
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
  return transform(obj, (s) => {
    let result = s;
    for (const [secret, placeholder] of scrubMap) {
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

function walk(obj: unknown, visitor: (s: string) => void): void {
  if (typeof obj === "string") {
    visitor(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) walk(item, visitor);
  } else if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj)) walk(value, visitor);
  }
}

function transform(obj: unknown, fn: (s: string) => string): unknown {
  if (typeof obj === "string") return fn(obj);
  if (Array.isArray(obj)) return obj.map((item) => transform(item, fn));
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = transform(value, fn);
    }
    return result;
  }
  return obj;
}
