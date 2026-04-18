/**
 * Shell sandbox — blocks dangerous commands before execution.
 *
 * Three levels:
 * - none: no restrictions (current default)
 * - restricted: block dangerous patterns, warn on risky ones
 * - container: Docker isolation (routes commands through DockerSandbox)
 */

export type SandboxLevel = "none" | "restricted" | "container";

export interface SandboxResult {
  allowed: boolean;
  reason?: string;
}

/** Patterns that are always blocked in restricted mode. */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive filesystem operations
  {
    pattern: /\brm\s+(-\w*r\w*\s+.*)?\/\s*$/,
    reason: "Recursive deletion of root filesystem",
  },
  {
    pattern: /\brm\s+-\w*rf\w*\s+\//,
    reason: "Recursive force deletion from root",
  },
  { pattern: /\bmkfs\b/, reason: "Filesystem creation is destructive" },
  { pattern: /\bdd\s+if=/, reason: "Raw disk operations blocked" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "Direct device writes blocked" },
  {
    pattern: /\bchmod\s+777\b/,
    reason: "World-writable permissions are insecure",
  },
  // Privilege escalation
  { pattern: /\bsudo\b/, reason: "Elevated privileges not allowed in sandbox" },
  { pattern: /\bsu\s+-c\b/, reason: "Privilege escalation via su blocked" },
  { pattern: /\bpkexec\b/, reason: "Privilege escalation via pkexec blocked" },
  { pattern: /\bdoas\b/, reason: "Privilege escalation via doas blocked" },
  // Fork bombs and system control
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: "Fork bomb detected" },
  { pattern: /\bshutdown\b/, reason: "System shutdown blocked" },
  { pattern: /\breboot\b/, reason: "System reboot blocked" },
  { pattern: /\binit\s+[06]\b/, reason: "System halt/reboot blocked" },
  // Remote code execution
  {
    pattern: /\bcurl\b.*\|\s*(ba)?sh/,
    reason: "Piping remote content to shell is risky",
  },
  {
    pattern: /\bwget\b.*\|\s*(ba)?sh/,
    reason: "Piping remote content to shell is risky",
  },
  {
    pattern: /\beval\s+"?\$\(.*curl/,
    reason: "Eval of remote content blocked",
  },
  // Encoding bypass detection — catch attempts to obfuscate dangerous commands
  {
    pattern: /\bbase64\s+(-d|--decode)\b.*\|\s*(ba)?sh/,
    reason: "Encoded command piped to shell blocked",
  },
  {
    pattern: /\bbase64\b.*\|\s*(ba)?sh/,
    reason: "Encoded command piped to shell blocked",
  },
  {
    pattern: /\bpython[23]?\s+-c\b/,
    reason: "Inline Python execution blocked in sandbox — use a .py file",
  },
  {
    pattern: /\bnode\s+-e\b/,
    reason: "Inline Node.js execution blocked in sandbox — use a .js file",
  },
  {
    pattern: /\bperl\s+-e\b/,
    reason: "Inline Perl execution blocked in sandbox — use a .pl file",
  },
  {
    pattern: /\bruby\s+-e\b/,
    reason: "Inline Ruby execution blocked in sandbox — use a .rb file",
  },
  {
    pattern: /\$'\\x[0-9a-fA-F]/,
    reason: "ANSI-C quoted escape sequence blocked",
  },
  // Git history rewriting
  {
    pattern: /\bgit\s+filter-branch\b/,
    reason: "History rewriting via filter-branch blocked",
  },
  {
    pattern: /\bgit\s+filter-repo\b/,
    reason: "History rewriting via filter-repo blocked",
  },
  {
    pattern: /\bgit\s+gc\s+.*--prune=now/,
    reason: "Aggressive garbage collection blocked",
  },
  {
    pattern: /\bgit\s+reflog\s+expire\s+.*--expire=now/,
    reason: "Reflog expiry blocked",
  },
  // Sensitive-path reads (v11 Attacker finding): pre-pass-30,
  // `restricted` blocked destructive command PATTERNS but did NOT
  // block READING credential files. A prompt-injection payload could
  // `cat ~/.ssh/id_rsa` or `cat ~/.aws/credentials` freely. These
  // paths hold keys that the process.env scrub can't cover because
  // they're on disk, not in env. Match anywhere in the command; any
  // tool (cat/head/tail/less/xxd/< redirect) hits the same pattern.
  //
  // This is path-name defense, not a real capability sandbox — a
  // determined attacker can still read via alternative paths (symlinks,
  // /proc reads, tool-chained obfuscation). For true FS isolation the
  // user must run sandbox="container". This closes the obvious path.
  {
    pattern: /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.ssh\//,
    reason:
      "Reading ~/.ssh/* blocked — use sandbox=container for workspace-edit workflows that need SSH",
  },
  {
    pattern: /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.aws\/credentials/,
    reason: "Reading AWS credentials blocked",
  },
  {
    pattern: /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.netrc/,
    reason: "Reading ~/.netrc blocked (contains remote auth tokens)",
  },
  {
    pattern: /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.config\/op\//,
    reason: "Reading 1Password config blocked",
  },
  {
    pattern: /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.gnupg\//,
    reason: "Reading GPG keyring blocked",
  },
  {
    pattern:
      /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.docker\/config\.json/,
    reason: "Reading Docker registry config blocked (contains auth)",
  },
  {
    pattern: /(?:~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/\.npmrc/,
    reason: "Reading ~/.npmrc blocked (may contain auth tokens)",
  },
  {
    pattern: /\/etc\/shadow\b|\/etc\/sudoers\b/,
    reason: "Reading /etc/shadow or /etc/sudoers blocked",
  },
  {
    pattern: /\/proc\/[^/\s]+\/environ\b/,
    reason: "Reading /proc/*/environ blocked (leaks parent env)",
  },
];

/**
 * Check if a command is allowed under the given sandbox level.
 */
export function checkSandbox(
  command: string,
  level: SandboxLevel,
  projectPath?: string,
): SandboxResult {
  if (level === "none") {
    return { allowed: true };
  }

  if (level === "container") {
    // Container mode: Docker provides isolation, allow all commands
    return { allowed: true };
  }

  return checkRestricted(command, projectPath);
}

function checkRestricted(command: string, projectPath?: string): SandboxResult {
  // Phase 1: Check blocked patterns against the FULL command string first.
  // This catches pipe-based patterns like "curl ... | sh" that would be
  // destroyed by command splitting (the pipe is the attack vector).
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(command)) {
      return { allowed: false, reason: `Sandbox blocked: ${reason}` };
    }
  }

  // Phase 2: Split chained commands and check each subcommand independently.
  // Catches bypass via: "npm install; rm -rf /" where Phase 1 might miss
  // patterns that only appear in a subcommand (e.g., after ; or &&).
  const subcommands = splitChainedCommands(command);

  for (const sub of subcommands) {
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(sub)) {
        return { allowed: false, reason: `Sandbox blocked: ${reason}` };
      }
    }

    if (projectPath) {
      const systemPaths =
        /(?:>|tee|cp|mv|install)\s+\/?(?:usr|etc|var|opt|tmp|home|root|Library|System|private|proc|sys|dev)\//;
      if (systemPaths.test(sub)) {
        return {
          allowed: false,
          reason: "Sandbox blocked: writing outside project directory",
        };
      }
    }
  }

  return { allowed: true };
}

/** Split shell command into subcommands (;, &&, ||, |, $(), backticks). */
function splitChainedCommands(command: string): string[] {
  const parts = command.split(/\s*(?:;|&&|\|\||\|)\s*/);
  const subshellRe = /\$\(([^)]+)\)|`([^`]+)`/g;
  let m;
  while ((m = subshellRe.exec(command)) !== null) {
    parts.push(m[1] ?? m[2]);
  }
  return parts.filter((p) => p.trim().length > 0);
}
