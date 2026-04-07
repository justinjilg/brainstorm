/**
 * Tool Sequence Anomaly Detector — catches dangerous multi-step attack patterns.
 *
 * Static "block shell after file_read" rules produce false positives because
 * reading a config then running npm install is normal. The key design: sequences
 * are only flagged when the trust window (from Phase 1) is tainted.
 *
 * Detected patterns:
 *   1. Secret-like content in recent context + outbound network call
 *   2. file_read of sensitive path + shell with encoding/network commands
 *   3. web_fetch (untrusted) → file_write (persistence of malicious content)
 *   4. web_fetch → memory (prompt poisoning via external content)
 *
 * Each pattern has a trust threshold — if the window's minTrust is above it,
 * the sequence is allowed (legitimate trusted workflow).
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("tool-sequence-detector");

// ── Sensitive Path Patterns ────────────────────────────────────────

const SENSITIVE_PATH_PATTERNS = [
  /\.env/i,
  /credentials/i,
  /\.aws\//i,
  /\.ssh\//i,
  /\.gnupg\//i,
  /\.config\/gcloud/i,
  /\.kube\/config/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /secret/i,
  /token/i,
  /password/i,
  /\.vault/i,
  /\.brainstorm\/vault/i,
];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((p) => p.test(path));
}

// ── Exfiltration Indicators ────────────────────────────────────────

const EXFIL_COMMAND_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/,
  /\bnetcat\b/i,
  /\bssh\b.*@/,
  /\bscp\b/,
  /\brsync\b/,
  /\bftp\b/,
  /\bhttp[s]?:\/\//,
  /\bbase64\b/,
  /\bxxd\b/,
  /\bopenssl\b.*enc/,
];

function hasExfilIndicators(command: string): boolean {
  return EXFIL_COMMAND_PATTERNS.some((p) => p.test(command));
}

// ── Sequence History ───────────────────────────────────────────────

interface ToolEvent {
  tool: string;
  timestamp: number;
  flags: {
    sensitiveRead?: boolean;
    untrustedSource?: boolean;
    hasSecretContent?: boolean;
  };
}

const HISTORY_SIZE = 10;
const SEQUENCE_WINDOW_MS = 60_000; // Only look at last 60s of history

// ── Sequence Rules ─────────────────────────────────────────────────

interface SequenceRule {
  name: string;
  /** Recent tool events that set up the attack (matched in order). */
  precondition: (history: ToolEvent[]) => boolean;
  /** The tool call that triggers the rule. */
  trigger: (call: MiddlewareToolCall) => boolean;
  /** Trust threshold — above this, the sequence is allowed. */
  trustThreshold: number;
  /** Human-readable reason for the block. */
  reason: string;
}

const SEQUENCE_RULES: SequenceRule[] = [
  {
    name: "sensitive-read-then-network",
    precondition: (history) => history.some((e) => e.flags.sensitiveRead),
    trigger: (call) => {
      if (call.name !== "shell") return false;
      const cmd = String(call.input.command ?? "");
      return hasExfilIndicators(cmd);
    },
    trustThreshold: 0.6,
    reason:
      "Sensitive file was read recently — blocking shell command with network/encoding indicators. This looks like a potential exfiltration chain.",
  },
  {
    name: "untrusted-source-then-write",
    precondition: (history) => history.some((e) => e.flags.untrustedSource),
    trigger: (call) =>
      ["file_write", "file_edit", "multi_edit", "batch_edit"].includes(
        call.name,
      ),
    trustThreshold: 0.5,
    reason:
      "Untrusted external content in context — blocking file write. Content from web_fetch/web_search should not be persisted without review.",
  },
  {
    name: "untrusted-source-then-memory",
    precondition: (history) => history.some((e) => e.flags.untrustedSource),
    trigger: (call) =>
      call.name === "memory" && String(call.input.operation ?? "") === "write",
    trustThreshold: 0.5,
    reason:
      "Untrusted external content in context — blocking memory write. This prevents prompt poisoning via external content entering persistent memory.",
  },
  {
    name: "untrusted-source-then-shell",
    precondition: (history) => history.some((e) => e.flags.untrustedSource),
    trigger: (call) => call.name === "shell",
    trustThreshold: 0.5,
    reason:
      "Untrusted external content in context — blocking shell execution. An attacker could embed commands in web content that the agent then executes.",
  },
  {
    name: "sensitive-read-then-web-fetch",
    precondition: (history) => history.some((e) => e.flags.sensitiveRead),
    trigger: (call) => call.name === "web_fetch",
    trustThreshold: 0.6,
    reason:
      "Sensitive file was read recently — blocking outbound web request. Secrets in context + outbound network = exfiltration risk.",
  },
];

// ── Middleware ──────────────────────────────────────────────────────

const SEQUENCE_HISTORY_KEY = "_toolSequenceHistory";
const TRUST_WINDOW_KEY = "_trustWindow";

interface TrustWindowLike {
  minTrust: number;
  tainted: boolean;
}

export function createToolSequenceDetectorMiddleware(): AgentMiddleware {
  let history: ToolEvent[] = [];

  return {
    name: "tool-sequence-detector",

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      // Prune old events outside the sequence window
      const cutoff = Date.now() - SEQUENCE_WINDOW_MS;
      history = history.filter((e) => e.timestamp > cutoff);

      // Get current trust from the trust propagation middleware
      const trustWindow = _currentTrustRef;
      const currentTrust = trustWindow?.minTrust ?? 1.0;

      for (const rule of SEQUENCE_RULES) {
        if (!rule.precondition(history)) continue;
        if (!rule.trigger(call)) continue;

        // If trust is above the rule's threshold, allow it
        if (currentTrust >= rule.trustThreshold) continue;

        log.warn(
          {
            rule: rule.name,
            tool: call.name,
            currentTrust,
            threshold: rule.trustThreshold,
            recentTools: history.map((e) => e.tool),
          },
          "Tool sequence blocked",
        );

        return {
          blocked: true,
          reason: `[${rule.name}] ${rule.reason} (trust: ${currentTrust.toFixed(1)}, requires: ${rule.trustThreshold})`,
          middleware: "tool-sequence-detector",
        };
      }
    },

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      const flags: ToolEvent["flags"] = {};

      // Detect sensitive file reads
      if (
        result.name === "file_read" &&
        typeof result.output === "object" &&
        result.output !== null
      ) {
        const output = result.output as Record<string, unknown>;
        const path = String(output.path ?? output.file ?? "");
        if (isSensitivePath(path)) {
          flags.sensitiveRead = true;
        }
      }

      // Detect untrusted sources
      if (["web_fetch", "web_search"].includes(result.name)) {
        flags.untrustedSource = true;
      }

      // Detect secret-like content in shell output
      if (result.name === "shell" && typeof result.output === "string") {
        if (looksLikeSecrets(result.output)) {
          flags.hasSecretContent = true;
          flags.sensitiveRead = true; // Treat as sensitive read
        }
      }

      history.push({
        tool: result.name,
        timestamp: Date.now(),
        flags,
      });

      // Keep history bounded
      if (history.length > HISTORY_SIZE) {
        history = history.slice(-HISTORY_SIZE);
      }
    },
  };
}

/** Rough heuristic: does this output contain secret-looking content? */
function looksLikeSecrets(content: string): boolean {
  const patterns = [
    /[A-Z0-9]{20,}/, // Long uppercase strings (API keys)
    /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/,
    /AKIA[0-9A-Z]{16}/, // AWS access key
    /ghp_[A-Za-z0-9]{36}/, // GitHub PAT
    /sk-[A-Za-z0-9]{32,}/, // OpenAI-style key
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/, // JWT
  ];
  return patterns.some((p) => p.test(content));
}

// ── Trust Window Bridge ────────────────────────────────────────────

/** Reference to the current trust window (set by trust-propagation middleware). */
let _currentTrustRef: TrustWindowLike | null = null;

/**
 * Set the trust window reference for the sequence detector.
 * Called by the middleware pipeline to share trust state.
 */
export function setSequenceDetectorTrustRef(
  trustWindow: TrustWindowLike | null,
): void {
  _currentTrustRef = trustWindow;
}
