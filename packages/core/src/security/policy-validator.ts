/**
 * Policy File Validator — treats local config/context files as potentially hostile inputs.
 *
 * Files like BRAINSTORM.md, .storm, agent definitions, and skill files are
 * "policy-bearing artifacts" — they shape agent behavior. If an attacker can
 * modify these files (via git commit, PR, or filesystem access), they can
 * inject instructions that persist across sessions.
 *
 * This module scans these files for suspicious patterns before they enter
 * the agent's instruction plane.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("policy-validator");

export interface PolicyValidationResult {
  safe: boolean;
  findings: PolicyFinding[];
}

export interface PolicyFinding {
  severity: "low" | "medium" | "high";
  pattern: string;
  snippet: string;
  location: string;
}

/** Patterns that indicate potential instruction injection in policy files. */
const INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  severity: PolicyFinding["severity"];
  description: string;
}> = [
  // Direct instruction override
  {
    pattern: /ignore\s+(previous|prior|all|your)\s+instructions/i,
    severity: "high",
    description: "Instruction override attempt",
  },
  {
    pattern: /you\s+(are|must)\s+now\s/i,
    severity: "high",
    description: "Identity/behavior override",
  },
  {
    pattern: /override\s+(your|safety|security)/i,
    severity: "high",
    description: "Safety override attempt",
  },
  {
    pattern: /\[system\]|\[admin\]|\[root\]/i,
    severity: "high",
    description: "Role escalation marker",
  },

  // Credential/exfiltration patterns
  {
    pattern: /curl\s+.*\$\(|wget\s+.*\$\(/i,
    severity: "high",
    description: "Command substitution in network call",
  },
  {
    pattern: /exfiltrate|data.*leak|send.*to.*server/i,
    severity: "medium",
    description: "Exfiltration language",
  },

  // Hidden instruction techniques
  {
    pattern: /<!--[\s\S]{50,}-->/g,
    severity: "medium",
    description: "Long HTML comment (possible hidden instructions)",
  },
  {
    pattern: /\u200B|\u200C|\u200D|\uFEFF/g,
    severity: "medium",
    description: "Zero-width characters (steganographic hiding)",
  },

  // Identity manipulation
  {
    pattern: /i\s+am\s+(an?\s+)?(unrestricted|unfiltered|uncensored)/i,
    severity: "high",
    description: "Identity falsification",
  },
  {
    pattern: /no\s+safety\s+guidelines/i,
    severity: "high",
    description: "Safety guideline denial",
  },
  {
    pattern: /pretend\s+(you|to)\s+(are|be)/i,
    severity: "medium",
    description: "Role-play injection",
  },

  // Security feature suppression (subtle policy manipulation)
  {
    pattern: /always\s+use\s+auto\s+mode/i,
    severity: "high",
    description: "Instruction to disable permission checks (auto mode)",
  },
  {
    pattern:
      /skip\s+(confirmation|approval|permission|verification)\s+(prompt|check|step|dialog)/i,
    severity: "high",
    description: "Instruction to bypass confirmation prompts",
  },
  {
    pattern:
      /disable\s+(security|safety|permission|confirmation|check|guard|scan)/i,
    severity: "high",
    description: "Instruction to disable security features",
  },
  {
    pattern: /always\s+allow\b|never\s+(?:ask|prompt|confirm|block|deny)/i,
    severity: "high",
    description: "Instruction to remove all safety gates",
  },
  {
    pattern: /without\s+(?:asking|confirming|checking|approval|permission)/i,
    severity: "medium",
    description: "Instruction to bypass human-in-the-loop",
  },
  {
    pattern: /trust\s+all\s+(?:input|content|files|sources)/i,
    severity: "high",
    description: "Instruction to disable trust boundary enforcement",
  },
];

/**
 * Validate a policy file (BRAINSTORM.md, .storm, agent def, skill) for injection patterns.
 */
export function validatePolicyFile(
  content: string,
  filename: string,
): PolicyValidationResult {
  const findings: PolicyFinding[] = [];

  for (const { pattern, severity, description } of INJECTION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split("\n").length;
      findings.push({
        severity,
        pattern: description,
        snippet: match[0].slice(0, 80),
        location: `${filename}:${lineNum}`,
      });

      if (!pattern.global) break;
    }
  }

  if (findings.length > 0) {
    const highCount = findings.filter((f) => f.severity === "high").length;
    log.warn(
      {
        file: filename,
        total: findings.length,
        high: highCount,
        findings: findings.map((f) => `${f.severity}: ${f.pattern}`),
      },
      "Suspicious patterns in policy file",
    );
  }

  return {
    safe: !findings.some((f) => f.severity === "high"),
    findings,
  };
}

/**
 * Validate a .storm file's memory entries for adversarial content.
 */
export function validateStormMemoryEntries(
  entries: Array<{ name: string; content: string }>,
  stormFilename: string,
): PolicyValidationResult {
  const findings: PolicyFinding[] = [];

  for (const entry of entries) {
    const result = validatePolicyFile(
      entry.content,
      `${stormFilename}:memory:${entry.name}`,
    );
    findings.push(...result.findings);
  }

  return {
    safe: !findings.some((f) => f.severity === "high"),
    findings,
  };
}
