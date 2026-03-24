/**
 * Scans text for credential patterns and redacts them before sending to LLM providers.
 * 13 regex patterns matching common credential formats.
 */

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Credential', pattern: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
  { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
  { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9_]{36,}/g },
  { name: 'OpenAI Key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'Anthropic Key', pattern: /sk-ant-[A-Za-z0-9-]{20,}/g },
  { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'Google API Key', pattern: /AIza[A-Za-z0-9_-]{35}/g },
  { name: 'PEM Private Key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'Basic Auth URL', pattern: /https?:\/\/[^:]+:[^@]+@/g },
  { name: 'Generic Credential', pattern: /(?:password|token|api_key|apikey)\s*[:=]\s*['"]([^'"]{8,})['"/]/gi },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'BR API Key', pattern: /br_(?:live|test)_[A-Za-z0-9]{20,}/g },
];

export interface ScanResult {
  hasFindings: boolean;
  findings: Array<{ name: string; position: number; preview: string }>;
}

/**
 * Scan text for credential patterns.
 */
export function scanForCredentials(text: string): ScanResult {
  const findings: ScanResult['findings'] = [];

  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      findings.push({
        name,
        position: match.index,
        preview: match[0].slice(0, 6) + '...[REDACTED]',
      });
    }
  }

  return { hasFindings: findings.length > 0, findings };
}

/**
 * Redact all detected credentials in text.
 */
export function redactCredentials(text: string): string {
  let result = text;
  for (const { pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
