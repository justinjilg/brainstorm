/**
 * Markdown / Content Scanner — detects suspicious patterns in fetched content.
 *
 * Scans content (markdown, HTML, plain text) from external sources for patterns
 * that indicate prompt injection, hidden instructions, or payload delivery.
 *
 * Different from policy-validator.ts: that module scans LOCAL config files
 * (BRAINSTORM.md, .storm). This module scans EXTERNAL content from web_fetch,
 * web_search, and file_read of untrusted files.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("markdown-scanner");

export interface ScanFinding {
  category: string;
  severity: "low" | "medium" | "high";
  detail: string;
  /** Character offset in the content where the finding starts. */
  offset: number;
}

export interface ContentScanResult {
  safe: boolean;
  findings: ScanFinding[];
  /** Risk score 0.0 (safe) to 1.0 (definitely malicious). */
  riskScore: number;
}

// ── Scan Rules ─────────────────────────────────────────────────────

interface ScanRule {
  category: string;
  pattern: RegExp;
  severity: ScanFinding["severity"];
  detail: string;
  /** Weight for risk score calculation. */
  weight: number;
}

const SCAN_RULES: ScanRule[] = [
  // ── Prompt Injection ──
  {
    category: "prompt-injection",
    pattern:
      /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|context|rules)/gi,
    severity: "high",
    detail: "Instruction override attempt",
    weight: 0.4,
  },
  {
    category: "prompt-injection",
    pattern: /you\s+(are|must)\s+now\s+(a|an|the|my)\s/gi,
    severity: "high",
    detail: "Identity/role override attempt",
    weight: 0.4,
  },
  {
    category: "prompt-injection",
    pattern: /\[system\]|\[INST\]|\[\/INST\]|<\|im_start\|>|<\|system\|>/gi,
    severity: "high",
    detail: "Chat template injection markers",
    weight: 0.5,
  },
  {
    category: "prompt-injection",
    pattern: /new\s+instructions?\s*:/gi,
    severity: "high",
    detail: "Instruction injection prefix",
    weight: 0.3,
  },
  {
    category: "prompt-injection",
    pattern:
      /(?:do|please)\s+not\s+(?:mention|tell|reveal|disclose)\s+(?:this|these|the)\s+(?:instructions?|rules?|prompt)/gi,
    severity: "high",
    detail: "Meta-instruction to hide injection",
    weight: 0.5,
  },

  // ── Indirect Injection (social engineering) ──
  {
    category: "prompt-injection",
    pattern:
      /(?:the\s+user|they|he|she)\s+(?:wanted|asked|told|said|requested|mentioned|instructed)\s+(?:you|me)\s+to\b/gi,
    severity: "high",
    detail:
      "Indirect instruction attribution (pretending a prior user request)",
    weight: 0.4,
  },
  {
    category: "prompt-injection",
    pattern:
      /(?:as\s+(?:instructed|requested|mentioned|discussed)\s+(?:earlier|before|previously|above))/gi,
    severity: "medium",
    detail: "False reference to prior instructions",
    weight: 0.3,
  },
  {
    category: "prompt-injection",
    pattern:
      /(?:remember|recall|don't\s+forget)\s+(?:that\s+)?(?:you|your)\s+(?:were|are)\s+(?:supposed|meant|expected)\s+to/gi,
    severity: "high",
    detail: "False memory implantation (claiming a prior commitment)",
    weight: 0.4,
  },
  {
    category: "prompt-injection",
    pattern:
      /(?:the\s+)?(?:correct|proper|right|intended)\s+(?:behavior|action|response)\s+is\s+to/gi,
    severity: "medium",
    detail:
      "Normative framing (defining correct behavior from untrusted source)",
    weight: 0.3,
  },

  // ── Dangerous URLs ──
  {
    category: "dangerous-url",
    pattern: /javascript\s*:/gi,
    severity: "high",
    detail: "javascript: URL protocol",
    weight: 0.3,
  },
  {
    category: "dangerous-url",
    pattern: /data\s*:\s*text\/html/gi,
    severity: "medium",
    detail: "data:text/html URL (potential payload carrier)",
    weight: 0.2,
  },
  {
    category: "dangerous-url",
    pattern: /vbscript\s*:/gi,
    severity: "medium",
    detail: "vbscript: URL protocol",
    weight: 0.2,
  },

  // ── Hidden Content ──
  {
    category: "hidden-content",
    pattern: /<!--[\s\S]{100,}?-->/g,
    severity: "medium",
    detail: "Long HTML comment (>100 chars) — may hide instructions",
    weight: 0.2,
  },
  {
    category: "hidden-content",
    pattern:
      /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064]{3,}/g,
    severity: "medium",
    detail: "Cluster of zero-width characters (steganographic content)",
    weight: 0.3,
  },
  {
    category: "hidden-content",
    pattern:
      /color\s*:\s*(?:white|transparent|rgba?\([^)]*,\s*0\s*\))|font-size\s*:\s*0/gi,
    severity: "medium",
    detail: "CSS hiding technique (invisible text)",
    weight: 0.3,
  },
  {
    category: "hidden-content",
    pattern: /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/gi,
    severity: "low",
    detail: "CSS visibility hiding (common but suspicious in fetched content)",
    weight: 0.1,
  },

  // ── Payload Delivery ──
  {
    category: "payload",
    pattern: /[A-Za-z0-9+/]{300,}={0,2}/g,
    severity: "medium",
    detail: "Large base64 block (>300 chars) — potential encoded payload",
    weight: 0.2,
  },
  {
    category: "payload",
    pattern: /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){10,}/gi,
    severity: "medium",
    detail: "Hex-encoded byte sequence — potential encoded payload",
    weight: 0.3,
  },

  // ── Exfiltration Instructions ──
  {
    category: "exfiltration",
    pattern: /send\s+(?:the\s+)?(?:contents?|data|file|output|result)\s+to/gi,
    severity: "medium",
    detail: "Exfiltration instruction language",
    weight: 0.3,
  },

  // ── Tool Manipulation ──
  {
    category: "tool-manipulation",
    pattern:
      /(?:write|create|modify|edit)\s+(?:the\s+)?(?:file|config|credentials)/gi,
    severity: "medium",
    detail: "Instruction to modify files/credentials",
    weight: 0.3,
  },
];

// ── Scanner ────────────────────────────────────────────────────────

/**
 * Scan content from external sources for suspicious patterns.
 * Returns findings and a composite risk score.
 */
export function scanContent(content: string): ContentScanResult {
  // Input size limit
  const MAX_SCAN_SIZE = 1_000_000;
  if (content.length > MAX_SCAN_SIZE) {
    content = content.slice(0, MAX_SCAN_SIZE);
  }

  try {
    return _scanContentUnsafe(content);
  } catch (err) {
    // FAIL CLOSED: if scanning crashes, report as unsafe
    log.error(
      { err, inputLength: content.length },
      "Content scan crashed — reporting as unsafe (fail-closed)",
    );
    return {
      safe: false,
      findings: [
        {
          category: "scan-error",
          severity: "high",
          detail: `Scanner crashed: ${err instanceof Error ? err.message : "unknown"}`,
          offset: 0,
        },
      ],
      riskScore: 1.0,
    };
  }
}

function _scanContentUnsafe(content: string): ContentScanResult {
  const findings: ScanFinding[] = [];
  let totalWeight = 0;

  for (const rule of SCAN_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      findings.push({
        category: rule.category,
        severity: rule.severity,
        detail: `${rule.detail}: "${match[0].slice(0, 60).replace(/[\x00-\x1f\x7f-\x9f]/g, "")}"`,
        offset: match.index,
      });
      totalWeight += rule.weight;

      if (!rule.pattern.global) break;
    }
  }

  // Clamp risk score to [0, 1]
  const riskScore = Math.min(1.0, totalWeight);
  const safe = findings.filter((f) => f.severity === "high").length === 0;

  if (findings.length > 0) {
    log.warn(
      {
        findingCount: findings.length,
        riskScore: riskScore.toFixed(2),
        categories: [...new Set(findings.map((f) => f.category))],
      },
      "Content scan: suspicious patterns detected",
    );
  }

  return { safe, findings, riskScore };
}
