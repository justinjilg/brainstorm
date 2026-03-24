import type { TaskProfile, RoutingDecision, StrategyName } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('telemetry');

/** Max header value size — conservative limit for proxy compatibility. */
const MAX_HEADER_BYTES = 512;

/**
 * Compact wire format for the x-br-metadata header.
 * Short keys keep the header small. Gateway parses via its metadata middleware.
 */
export interface RoutingMetadata {
  /** Schema version — always increment when adding/renaming fields */
  v: 1;
  /** Task type (maps to TaskProfile.type) */
  tt: string;
  /** Complexity (maps to TaskProfile.complexity) */
  cx: string;
  /** Requires tool use */
  tu: boolean;
  /** Requires reasoning */
  rr: boolean;
  /** Programming language (optional) */
  lang?: string;
  /** Domain (optional) */
  dom?: string;
  /** Routing strategy used by CLI */
  st: StrategyName;
  /** Selected model ID */
  mid: string;
  /** Estimated cost from routing decision */
  ec: number;
  /** Routing reason (truncated, ASCII-safe) */
  rs?: string;
  /** Source identifier */
  src: 'cli';
}

/** Strip non-ASCII characters (HTTP headers are ASCII-only per RFC 7230). */
function asciiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '');
}

/**
 * Serialize a TaskProfile + RoutingDecision into a compact JSON string
 * for the x-br-metadata request header.
 *
 * Returns undefined if serialization fails (caller should skip the header).
 * Failures are logged at warn level — telemetry should never be silent.
 */
export function serializeRoutingMetadata(
  task: TaskProfile,
  decision: RoutingDecision,
): string | undefined {
  try {
    const meta: RoutingMetadata = {
      v: 1,
      tt: task.type,
      cx: task.complexity,
      tu: task.requiresToolUse,
      rr: task.requiresReasoning,
      st: decision.strategy,
      mid: decision.model.id,
      ec: Math.round(decision.estimatedCost * 1_000_000) / 1_000_000,
      src: 'cli',
    };

    // Optional fields — gateway enforces max 10 key-value pairs.
    // Base has 9 keys. Add at most 1 optional field to stay under limit.
    if (task.language) meta.lang = task.language;
    else if (task.domain) meta.dom = task.domain;
    else if (decision.reason) meta.rs = asciiSafe(decision.reason.slice(0, 64));

    let serialized = JSON.stringify(meta);

    // If over size budget, drop optional fields
    if (serialized.length > MAX_HEADER_BYTES) {
      delete meta.rs;
      delete meta.dom;
      delete meta.lang;
      serialized = JSON.stringify(meta);
    }

    return serialized;
  } catch (error) {
    log.warn(
      { err: error, taskType: task?.type, modelId: decision?.model?.id },
      'Failed to serialize routing metadata — header will be omitted',
    );
    return undefined;
  }
}
