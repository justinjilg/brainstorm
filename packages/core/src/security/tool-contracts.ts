/**
 * Tool Argument Contracts — per-tool validation at the action boundary.
 *
 * Each high-risk tool gets a contract that validates arguments BEFORE execution.
 * This is the last line of defense: even if taint tracking fails and sequence
 * detection misses the pattern, the tool contract catches dangerous arguments.
 *
 * Contracts are intentionally conservative — they block suspicious patterns
 * and require human approval to override. False positives are acceptable here
 * because the alternative is data exfiltration or code injection.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("tool-contracts");

export interface ContractViolation {
  tool: string;
  rule: string;
  detail: string;
  severity: "warning" | "block";
}

export interface ContractResult {
  valid: boolean;
  violations: ContractViolation[];
}

// ── Shell Contract ─────────────────────────────────────────────────

/** Commands that should never be executed by an agent. */
const SHELL_DENYLIST: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+-rf\s+[/~]/,
    reason: "Recursive delete from root or home directory",
  },
  {
    pattern: /\bdd\s+.*of=\/dev\//,
    reason: "Direct disk write via dd",
  },
  {
    pattern: /\bmkfs\b/,
    reason: "Filesystem format command",
  },
  {
    pattern: /\bchmod\s+777\b/,
    reason: "World-writable permissions",
  },
  {
    pattern: /\bchown\s+.*:.*\s+\//,
    reason: "Changing ownership of root-level paths",
  },
  {
    pattern: /\b(iptables|ufw)\s+.*(DROP|REJECT|flush)/i,
    reason: "Firewall rule modification",
  },
  {
    pattern: /\bsystemctl\s+(stop|disable|mask)\b/i,
    reason: "Stopping system services",
  },
  {
    pattern: /\bkill\s+-9\s+1\b/,
    reason: "Killing init/systemd (PID 1)",
  },
  {
    pattern: />(\/dev\/null|\s*\/dev\/stderr)\s*2>&1\s*&/,
    reason: "Suppressing all output (hiding activity)",
  },
  {
    pattern: /\bhistory\s+-c\b/,
    reason: "Clearing shell history (covering tracks)",
  },
  {
    pattern: /\bcrontab\s+-r\b/,
    reason: "Deleting all cron jobs",
  },
  {
    pattern: /\b(passwd|useradd|usermod|groupadd)\b/,
    reason: "User/group modification",
  },
];

function validateShell(input: Record<string, unknown>): ContractViolation[] {
  const command = String(input.command ?? "");
  const violations: ContractViolation[] = [];

  for (const { pattern, reason } of SHELL_DENYLIST) {
    if (pattern.test(command)) {
      violations.push({
        tool: "shell",
        rule: "command-denylist",
        detail: reason,
        severity: "block",
      });
    }
  }

  // Detect command chaining that could bypass detection
  // e.g., `echo harmless && curl evil.com`
  const chainedCommands = command.split(/\s*[;&|]{1,2}\s*/);
  if (chainedCommands.length > 5) {
    violations.push({
      tool: "shell",
      rule: "excessive-chaining",
      detail: `Command chains ${chainedCommands.length} subcommands — complex chains are harder to audit`,
      severity: "warning",
    });
  }

  return violations;
}

// ── File Read Contract ─────────────────────────────────────────────

/** Paths that should require explicit approval before reading. */
const SENSITIVE_READ_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/\.ssh\//, reason: "SSH directory" },
  { pattern: /\/\.aws\//, reason: "AWS credentials" },
  { pattern: /\/\.gnupg\//, reason: "GPG keyring" },
  { pattern: /\/\.config\/gcloud\//, reason: "GCloud credentials" },
  { pattern: /\/\.kube\/config/, reason: "Kubernetes config" },
  { pattern: /\/\.docker\/config\.json/, reason: "Docker credentials" },
  { pattern: /\/\.npmrc$/, reason: "NPM config (may contain tokens)" },
  { pattern: /\/\.pypirc$/, reason: "PyPI credentials" },
  { pattern: /\/\.netrc$/, reason: "Network credentials" },
  { pattern: /\/etc\/shadow/, reason: "System password hashes" },
  { pattern: /\/etc\/passwd/, reason: "System user list" },
  { pattern: /\/var\/log\/auth/, reason: "Authentication logs" },
  {
    pattern: /\/(\.env|\.env\.local|\.env\.production)/,
    reason: "Environment file (likely contains secrets)",
  },
];

function validateFileRead(input: Record<string, unknown>): ContractViolation[] {
  const path = String(input.path ?? input.file_path ?? "");
  const violations: ContractViolation[] = [];

  for (const { pattern, reason } of SENSITIVE_READ_PATHS) {
    if (pattern.test(path)) {
      violations.push({
        tool: "file_read",
        rule: "sensitive-path",
        detail: `Reading ${reason}: ${path}`,
        severity: "block",
      });
    }
  }

  // Path traversal detection — any ../ outside the project is suspicious
  if (/\.\.[/\\]/.test(path)) {
    violations.push({
      tool: "file_read",
      rule: "path-traversal",
      detail: `Parent directory reference in path: ${path}`,
      severity: "block",
    });
  }

  return violations;
}

// ── File Write Contract ────────────────────────────────────────────

const PROTECTED_WRITE_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/\.ssh\//, reason: "SSH directory" },
  { pattern: /\/\.aws\//, reason: "AWS directory" },
  {
    pattern: /\/\.bashrc$|\/\.zshrc$|\/\.profile$/,
    reason: "Shell startup file (persistence mechanism)",
  },
  {
    pattern: /\/\.config\/autostart/,
    reason: "Autostart directory (persistence mechanism)",
  },
  {
    pattern: /\/cron\.d\/|\/crontab/,
    reason: "Cron configuration (persistence mechanism)",
  },
  {
    pattern: /\/etc\/systemd\//,
    reason: "Systemd units (persistence mechanism)",
  },
  {
    pattern: /\/LaunchAgents\/|\/LaunchDaemons\//,
    reason: "macOS launch services",
  },
];

function validateFileWrite(
  input: Record<string, unknown>,
): ContractViolation[] {
  const path = String(input.path ?? input.file_path ?? input.filePath ?? "");
  const violations: ContractViolation[] = [];

  for (const { pattern, reason } of PROTECTED_WRITE_PATHS) {
    if (pattern.test(path)) {
      violations.push({
        tool: "file_write",
        rule: "protected-path",
        detail: `Writing to ${reason}: ${path}`,
        severity: "block",
      });
    }
  }

  return violations;
}

// ── Web Fetch Contract ─────────────────────────────────────────────

/** URLs patterns that are always suspicious. */
const SUSPICIOUS_URL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(webhook\.site|requestbin|hookbin|pipedream\.net|burp)/i,
    reason: "Known data exfiltration/interception service",
  },
  {
    pattern: /\b(ngrok\.io|serveo\.net|localtunnel\.me)/i,
    reason: "Tunnel service (potential exfiltration endpoint)",
  },
  {
    pattern: /\b(pastebin\.com|hastebin\.com|dpaste)/i,
    reason: "Paste service (potential data drop)",
  },
  {
    pattern: /^data:/i,
    reason: "Data URL (not a real fetch target)",
  },
  {
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    reason: "Raw IP address (no DNS — harder to audit)",
  },
];

function validateWebFetch(input: Record<string, unknown>): ContractViolation[] {
  const url = String(input.url ?? "");
  const violations: ContractViolation[] = [];

  for (const { pattern, reason } of SUSPICIOUS_URL_PATTERNS) {
    if (pattern.test(url)) {
      violations.push({
        tool: "web_fetch",
        rule: "suspicious-url",
        detail: `${reason}: ${url.slice(0, 100)}`,
        severity: "warning",
      });
    }
  }

  return violations;
}

// ── God Mode Contract ──────────────────────────────────────────────

function validateGodModeTool(
  toolName: string,
  input: Record<string, unknown>,
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  // agent_run_tool: validate that the remote tool name is known
  if (toolName === "agent_run_tool") {
    const remoteTool = String(input.tool ?? input.tool_name ?? "");
    // God mode tools that can cause irreversible damage
    const DESTRUCTIVE_REMOTE_TOOLS = new Set([
      "reset_agent",
      "wipe_data",
      "delete_agent",
      "format_disk",
      "kill_all_agents",
    ]);
    if (DESTRUCTIVE_REMOTE_TOOLS.has(remoteTool)) {
      violations.push({
        tool: toolName,
        rule: "destructive-remote-tool",
        detail: `Destructive remote tool: ${remoteTool}`,
        severity: "block",
      });
    }
  }

  // agent_kill_switch: always warn
  if (toolName === "agent_kill_switch") {
    violations.push({
      tool: toolName,
      rule: "kill-switch-confirmation",
      detail: "Kill switch activation requires explicit human confirmation",
      severity: "warning",
    });
  }

  return violations;
}

// ── Contract Registry ──────────────────────────────────────────────

type ContractValidator = (
  toolName: string,
  input: Record<string, unknown>,
) => ContractViolation[];

const CONTRACT_REGISTRY: Record<string, ContractValidator> = {
  shell: (_name, input) => validateShell(input),
  process_spawn: (_name, input) => validateShell(input),
  file_read: (_name, input) => validateFileRead(input),
  file_write: (_name, input) => validateFileWrite(input),
  file_edit: (_name, input) => validateFileWrite(input),
  multi_edit: (_name, input) => validateFileWrite(input),
  batch_edit: (_name, input) => validateFileWrite(input),
  web_fetch: (_name, input) => validateWebFetch(input),
  agent_run_tool: (name, input) => validateGodModeTool(name, input),
  agent_kill_switch: (name, input) => validateGodModeTool(name, input),
  agent_workflow_approve: (name, input) => validateGodModeTool(name, input),
};

/**
 * Validate a tool call's arguments against its contract.
 * Returns violations (empty array = all clear).
 */
export function validateToolContract(
  toolName: string,
  input: Record<string, unknown>,
): ContractResult {
  const validator = CONTRACT_REGISTRY[toolName];
  if (!validator) return { valid: true, violations: [] };

  const violations = validator(toolName, input);

  if (violations.length > 0) {
    log.info(
      {
        tool: toolName,
        violations: violations.map((v) => `${v.severity}: ${v.rule}`),
      },
      "Tool contract violations detected",
    );
  }

  return {
    valid: violations.filter((v) => v.severity === "block").length === 0,
    violations,
  };
}

/**
 * Check if a tool has a registered contract.
 */
export function hasToolContract(toolName: string): boolean {
  return toolName in CONTRACT_REGISTRY;
}
