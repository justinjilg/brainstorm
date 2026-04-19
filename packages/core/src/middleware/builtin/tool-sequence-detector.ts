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
import { getActiveTrustWindow } from "./trust-propagation.js";
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
  /-F\s+\S*file=@/i, // curl file upload
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
  {
    name: "sensitive-path-then-upload",
    precondition: (history) => history.some((e) => e.flags.sensitiveRead),
    trigger: (call) => {
      if (call.name !== "shell") return false;
      const cmd = String(call.input.command ?? "");
      // Catch any outbound network command after sensitive path access
      // This fires at ALL trust levels — staging + exfil is suspicious regardless
      return hasExfilIndicators(cmd);
    },
    trustThreshold: 1.1, // Always fires (no trust level can reach 1.1)
    reason:
      "Sensitive path was accessed in a recent shell command, and this command has network/encoding indicators. Possible multi-step data staging and exfiltration.",
  },
];

// ── Middleware ──────────────────────────────────────────────────────

const SEQUENCE_HISTORY_KEY = "_toolSequenceHistory";
const TRUST_WINDOW_KEY = "_trustWindow";

export function createToolSequenceDetectorMiddleware(): AgentMiddleware {
  let history: ToolEvent[] = [];
  const preScannedCalls = new Set<string>(); // Track pre-scanned call IDs to avoid double-recording

  return {
    name: "tool-sequence-detector",

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      // Prune old events outside the sequence window
      const cutoff = Date.now() - SEQUENCE_WINDOW_MS;
      history = history.filter((e) => e.timestamp > cutoff);

      // Pre-scan: if this shell command touches sensitive paths, record it
      // in history so subsequent wrapToolCall checks see the taint.
      // afterToolResult will skip re-recording if already pre-scanned.
      if (call.name === "shell") {
        const cmd = String(call.input.command ?? "");
        const tokens = cmd.split(/\s+/);
        const touchesSensitive = tokens.some(
          (t) => !t.startsWith("-") && isSensitivePath(t),
        );
        if (touchesSensitive) {
          history.push({
            tool: "shell",
            timestamp: Date.now(),
            flags: { sensitiveRead: true },
          });
          if (history.length > HISTORY_SIZE) {
            history = history.slice(-HISTORY_SIZE);
          }
          preScannedCalls.add(call.id);
        }
      }

      // Get current trust from the trust-propagation middleware's
      // per-callId store. Pre-fix this read from `_currentTrustRef`,
      // a module-level variable that was never set in production —
      // `setSequenceDetectorTrustRef()` was exported but never called.
      // The consequence: `currentTrust` defaulted to 1.0 for every
      // call, and the trust-threshold bypass (`if (currentTrust >=
      // rule.trustThreshold) continue`) skipped every rule except
      // the one with a 1.1 threshold. The 5 rules with thresholds
      // 0.5/0.6 were effectively dead code.
      //
      // Now reads from the same Map trust-propagation uses, keyed by
      // call.id. If trust-propagation hasn't synced (not in a
      // wrapped-execute path, or called pre-integration), fall back
      // to the 1.0 default for backward compatibility.
      const trustWindow = getActiveTrustWindow(call.id);
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
          reason:
            "Tool call blocked by security policy. Check session logs for details.",
          middleware: "tool-sequence-detector",
        };
      }
    },

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      // Skip if already recorded by pre-scan in wrapToolCall
      if (preScannedCalls.has(result.toolCallId)) {
        preScannedCalls.delete(result.toolCallId);
        return;
      }

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

// Historic module-level trust-ref bridge removed — it was exported
// (`setSequenceDetectorTrustRef`) but never called in production,
// making 5 of 6 sequence rules dead code. The integration now goes
// through `getActiveTrustWindow(call.id)` from trust-propagation,
// which shares the same per-callId Map and is properly populated by
// loop.ts's syncTrustWindow bracket.
//
// Callers who previously imported `setSequenceDetectorTrustRef`
// should remove the call — it's a no-op that's been deleted. If
// you're reaching this comment via a git-blame, the replacement is
// automatic (no caller code change needed beyond deleting the
// obsolete set).
