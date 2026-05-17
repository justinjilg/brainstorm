/**
 * W3C Trace Context parsing + propagation.
 *
 * https://www.w3.org/TR/trace-context/
 *
 * The traceparent header carries a 4-part value:
 *   <version>-<trace_id>-<span_id>-<flags>
 *
 * For A2A receivers, the contract is:
 *   1. Parse incoming traceparent (REQUIRED — reject if missing/malformed)
 *   2. Generate a new span_id for local work, keep the trace_id
 *   3. Echo the updated traceparent in synchronous responses
 *   4. Stamp the (incoming) traceparent on every evidence + ChangeSet produced
 *   5. Forward the updated traceparent on any downstream A2A invocations
 */

import { randomBytes } from "node:crypto";
import type { TraceContext } from "./types.js";

const VERSION = "00";
const FLAG_SAMPLED = 0x01;
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(
  value: string | undefined | null,
): TraceContext | null {
  if (!value) return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  const version = m[1] as string;
  const trace_id = m[2] as string;
  const span_id = m[3] as string;
  const flags = m[4] as string;
  if (version === "ff") return null;
  if (trace_id === "0".repeat(32)) return null;
  if (span_id === "0".repeat(16)) return null;
  return { version, trace_id, span_id, flags };
}

export function formatTraceparent(tc: TraceContext): string {
  return `${tc.version}-${tc.trace_id}-${tc.span_id}-${tc.flags}`;
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function nextSpan(parent: TraceContext): TraceContext {
  return {
    version: VERSION,
    trace_id: parent.trace_id,
    span_id: newSpanId(),
    flags: parent.flags,
  };
}

export function newRootTraceparent(opts?: { sampled?: boolean }): TraceContext {
  const sampled = opts?.sampled ?? true;
  return {
    version: VERSION,
    trace_id: newTraceId(),
    span_id: newSpanId(),
    flags: sampled ? FLAG_SAMPLED.toString(16).padStart(2, "0") : "00",
  };
}

export function isSampled(tc: TraceContext): boolean {
  const f = parseInt(tc.flags, 16);
  return (f & FLAG_SAMPLED) === FLAG_SAMPLED;
}
