/**
 * Sensitive-file path enforcement for file tools.
 *
 * Shared with sandbox.ts's shell-sandbox checks, but applied at a
 * different layer: the shell sandbox checks the RAW command string,
 * this module checks the RESOLVED absolute path of a direct file
 * tool call.
 *
 * Why both exist: a prompt injection can reach a credential file
 * via either `shell("cat ~/.ssh/id_rsa")` (caught by sandbox.ts) OR
 * `file_read("/Users/alice/.ssh/id_rsa")` (caught here). Before this
 * module existed, `ensureSafePath()` in file-read.ts / file-edit.ts /
 * file-write.ts allowed anything under `$HOME` — including
 * credential directories. F5 closed the shell path; this closes the
 * file-tool path.
 *
 * The patterns run against the RESOLVED absolute path (after symlink
 * resolution would be ideal but `resolve()` doesn't follow symlinks
 * synchronously; realpath is a post-exec check the caller can layer).
 */

import { homedir } from "node:os";

/**
 * Compile a list of absolute path prefixes that should never be
 * readable/writable through the file tools, regardless of whether
 * they fall under the user's home dir.
 *
 * Computed once at module load — the patterns are based on homedir()
 * which doesn't change mid-process, and re-generating them per call
 * would show up on hot paths (every file_read).
 */
function buildBlockedPaths(): Array<{ prefix: string; reason: string }> {
  const home = homedir();
  const blocked: Array<{ prefix: string; reason: string }> = [
    {
      prefix: `${home}/.ssh/`,
      reason:
        "Reading ~/.ssh/* is blocked (SSH private keys). If this file tool genuinely needs SSH access, route through the shell with sandbox='container'.",
    },
    {
      prefix: `${home}/.aws/credentials`,
      reason: "Reading ~/.aws/credentials is blocked (cloud creds).",
    },
    {
      prefix: `${home}/.aws/config`,
      reason:
        "Reading ~/.aws/config is blocked (may contain MFA / profile info).",
    },
    {
      prefix: `${home}/.netrc`,
      reason: "Reading ~/.netrc is blocked (remote auth tokens).",
    },
    {
      prefix: `${home}/.config/op/`,
      reason: "Reading ~/.config/op/* is blocked (1Password CLI config).",
    },
    {
      prefix: `${home}/.gnupg/`,
      reason: "Reading ~/.gnupg/* is blocked (GPG keyring).",
    },
    {
      prefix: `${home}/.docker/config.json`,
      reason:
        "Reading ~/.docker/config.json is blocked (registry auth tokens).",
    },
    {
      prefix: `${home}/.npmrc`,
      reason: "Reading ~/.npmrc is blocked (may contain auth tokens).",
    },
    // macOS root-user home
    {
      prefix: "/var/root/.ssh/",
      reason: "Reading /var/root/.ssh/* is blocked (root user SSH keys).",
    },
    // Traditional Linux/BSD credential locations outside $HOME
    {
      prefix: "/etc/shadow",
      reason: "Reading /etc/shadow is blocked (password hashes).",
    },
    {
      prefix: "/etc/sudoers",
      reason: "Reading /etc/sudoers is blocked (sudoers policy).",
    },
  ];
  return blocked;
}

const BLOCKED_PATHS = buildBlockedPaths();

/**
 * Throw if the resolved absolute path matches a known credential
 * location. Intended to be called from `ensureSafePath()` in the
 * file tools after resolution but before any fs access.
 */
export function assertNotSensitivePath(resolvedPath: string): void {
  for (const { prefix, reason } of BLOCKED_PATHS) {
    // Direct prefix match catches both the directory form (ssh/)
    // and the exact-file form (.npmrc, .netrc).
    if (
      resolvedPath === prefix ||
      resolvedPath.startsWith(prefix) ||
      // For exact-file prefixes (e.g. `.npmrc`), a file named
      // exactly at that path should match without a trailing slash.
      resolvedPath === prefix.replace(/\/$/, "")
    ) {
      throw new Error(`Path blocked: ${reason}`);
    }
  }
}
