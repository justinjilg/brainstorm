/**
 * IPC wire-protocol primitives — pure functions, no DOM, no Electron.
 *
 * Extracted out of ipc-client.ts so the protocol layer has its own
 * testable surface. The Claude Agent SDK keeps
 * `test_subprocess_buffering.py` next to the transport code for the
 * same reason: if the wire format moves silently, a unit test fires
 * before any user sees it.
 *
 * Every named contract in this file has a matching case in
 * tests-protocol/ipc-protocol.test.ts. When you add a contract here,
 * add the test in the same commit.
 */

import type { AgentEvent } from "./api-client";

/**
 * The raw shape main.ts forwards to the renderer over the "chat-event"
 * IPC channel. The backend's NDJSON stream speaks this shape — {id,
 * event, data} — and useChat / trace / any consumer speaks the shape
 * below (AgentEvent, discriminated on `type`). `normalizeChatEvent`
 * is the adapter.
 *
 * History: this boundary shipped unadapted for a while, which meant
 * `switch (event.type)` never matched anything and every chat turn
 * emitted a done event with no text ever landing in the UI. See
 * tests-live/_repro/event-shape-mismatch.spec.ts for the regression
 * trap and tests-protocol/ipc-protocol.test.ts for the unit-level
 * contract coverage.
 */
export interface RawChatEventMessage {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  // Older code paths (HTTP SSE fallback, tests that inject events
  // directly) already speak the normalized shape — we pass those
  // through untouched.
  type?: string;
  [k: string]: unknown;
}

/**
 * Convert {id, event, data} → {type, ...data}.
 *
 * Contract:
 *  - Non-object inputs pass through (null, undefined, strings).
 *  - Inputs with a pre-existing `type` pass through (already-normalized).
 *  - Inputs with `event: "..."` become `{type: event, ...data}`.
 *  - `data` is spread after `type`; on key collision `type` wins (we
 *    don't let payloads fake their discriminator).
 *  - `id` is dropped — it's a transport concern; consumers don't read it.
 *
 * This is cheap and synchronous by design. Anyone reaching for
 * `async` or a Zod schema here should first check whether the cost
 * pays for itself on a hot path — every chat text-delta goes through
 * this function.
 */
export function normalizeChatEvent(raw: unknown): AgentEvent {
  if (!raw || typeof raw !== "object") return raw as AgentEvent;
  const msg = raw as RawChatEventMessage;
  if (typeof msg.type === "string") return msg as unknown as AgentEvent;
  if (typeof msg.event === "string") {
    const out: Record<string, unknown> = {
      ...(msg.data ?? {}),
      type: msg.event,
    };
    return out as unknown as AgentEvent;
  }
  return raw as AgentEvent;
}

/**
 * Parse a single NDJSON line from the backend's stdout. Returns the
 * parsed object, or null if the line is not JSON (pino logs emit
 * plain text to stderr but can occasionally leak into stdout via
 * subprocesses spawned by tools — we must not crash on those).
 *
 * Contract:
 *  - Empty / whitespace-only lines → null.
 *  - Non-JSON text → null (never throws).
 *  - JSON with a root array or scalar → null (we only accept objects).
 *  - Valid JSON object → the object.
 */
export function parseBackendLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * The backend's structured readiness signal. Emitted exactly once
 * when `brainstorm ipc` is ready to accept requests. main.ts uses
 * this to flip the sticky `backendReady` flag; the renderer uses
 * `getBackendReady` to resolve the race between "signal fires" and
 * "React subscribes." This predicate keeps the shape definition in
 * one place.
 */
export function isBackendReadyMessage(
  msg: Record<string, unknown>,
): msg is { type: "ready"; version?: string } {
  return msg.type === "ready";
}

/**
 * Detect a streaming event payload (anything with an `event` field).
 * Used by main.ts to decide whether to forward to all renderer windows
 * via chat-event, vs. resolve a pending request/response promise.
 */
export function isStreamingEvent(
  msg: Record<string, unknown>,
): msg is { event: string; id?: string; data?: Record<string, unknown> } {
  return typeof msg.event === "string";
}
