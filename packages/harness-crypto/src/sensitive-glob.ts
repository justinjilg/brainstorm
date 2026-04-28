import { minimatch } from "minimatch";
import { extname } from "node:path";

/**
 * Sensitive-path enforcement.
 *
 * Per PQC §4.2 (file naming and layout convention) and §6.3 (pre-commit
 * hook): every path matching a `sensitive` glob in `business.toml#access`
 * MUST end in an encrypted suffix (`.age` / `.sops.toml` / `.sops.yaml` /
 * `.sops.json`). Plaintext under a sensitive glob is a CI failure.
 *
 * The Anthropic-style packaging accident (Round 1 §1.3) demonstrated the
 * opposite policy — exclusion-list — fails when a new path is added and
 * forgotten. The harness's positive-allowlist convention (only encrypted
 * suffixes are valid for sensitive paths) makes the check robust.
 */

export const ENCRYPTED_SUFFIXES = [
  ".age",
  ".sops.toml",
  ".sops.yaml",
  ".sops.yml",
  ".sops.json",
] as const;

export type EncryptedSuffix = (typeof ENCRYPTED_SUFFIXES)[number];

/**
 * Determine whether a path satisfies the encrypted-suffix convention.
 *
 * Notes:
 *   - `.sops.toml` is a *compound* extension; we check string suffix.
 *   - `.age.envelope.toml` is a special plaintext envelope companion (per
 *     PQC §4.5 "auditable but encrypted") — treated as plaintext-ok by the
 *     primary suffix check; envelopes are validated by a separate function.
 */
export function hasEncryptedSuffix(path: string): boolean {
  // Envelope companion files are plaintext by design — let them through;
  // they are validated structurally elsewhere.
  if (path.endsWith(".envelope.toml")) return false;

  return ENCRYPTED_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** True if the path is a recognized envelope companion (`*.age.envelope.toml`). */
export function isEnvelopeCompanion(path: string): boolean {
  return path.endsWith(".age.envelope.toml");
}

/**
 * Check whether a single path matches any sensitive glob.
 *
 * Globs follow .gitignore-style patterns (minimatch semantics): `**` for
 * any subpath, `*` for single-segment wildcard, etc.
 */
export function matchesSensitiveGlob(
  path: string,
  sensitiveGlobs: string[],
): boolean {
  return sensitiveGlobs.some((g) =>
    minimatch(path, g, { dot: true, matchBase: false }),
  );
}

export interface SensitiveGlobViolation {
  /** The offending path (relative to harness root). */
  path: string;
  /** The first sensitive glob it matched. */
  matched_glob: string;
  /** What's wrong: plaintext where encryption is required, or unknown extension. */
  reason: "plaintext-under-sensitive" | "missing-encrypted-suffix";
}

/**
 * Validate a list of paths against a list of sensitive globs.
 *
 * Returns violations: paths that match a sensitive glob but lack an
 * encrypted suffix. This is the v1 lint that ships with `brainstorm
 * harness lint --strict`; CI fails on any violation.
 */
export function validateSensitivePaths(
  paths: string[],
  sensitiveGlobs: string[],
): SensitiveGlobViolation[] {
  const violations: SensitiveGlobViolation[] = [];
  for (const path of paths) {
    // Skip envelope companions (plaintext by design)
    if (isEnvelopeCompanion(path)) continue;

    // Find the first matching sensitive glob (if any)
    const matched_glob = sensitiveGlobs.find((g) =>
      minimatch(path, g, { dot: true, matchBase: false }),
    );
    if (!matched_glob) continue;

    if (!hasEncryptedSuffix(path)) {
      violations.push({
        path,
        matched_glob,
        reason: "plaintext-under-sensitive",
      });
    }
  }
  return violations;
}

/**
 * Quick predicate for "is this path supposed to be encrypted?" — used by
 * the AI agent's pre-write hook (Privilege Firewall §3) to decide whether
 * to refuse a write to a non-privileged destination.
 */
export function isSensitivePath(
  path: string,
  sensitiveGlobs: string[],
): boolean {
  return matchesSensitiveGlob(path, sensitiveGlobs);
}

/**
 * Strip the encrypted suffix from a path to recover the canonical "logical
 * path" — used for index keying. Treatment differs by encryption mode:
 *   - `.age` is whole-file encryption: `contract.md.age` → `contract.md`
 *     (the `.age` is a wrapper; logical content type is the inner ext).
 *   - `.sops.{ext}` is per-value encryption *inside* a structured file:
 *     `acme.sops.toml` → `acme.toml` (sops doesn't change the conceptual
 *     file type — it's still a TOML file, just with values encrypted).
 *
 * Used by the desktop's file browser to group encrypted artifacts under
 * their logical identity, and by the indexer to key entries by what they
 * "are" rather than how they're stored.
 */
export function logicalPath(path: string): string {
  if (path.endsWith(".age")) return path.slice(0, -".age".length);
  if (path.endsWith(".sops.toml")) {
    return path.slice(0, -".sops.toml".length) + ".toml";
  }
  if (path.endsWith(".sops.yaml")) {
    return path.slice(0, -".sops.yaml".length) + ".yaml";
  }
  if (path.endsWith(".sops.yml")) {
    return path.slice(0, -".sops.yml".length) + ".yml";
  }
  if (path.endsWith(".sops.json")) {
    return path.slice(0, -".sops.json".length) + ".json";
  }
  return path;
}

/** Inverse of logicalPath: append the encrypted suffix appropriate for the
 * file's content type. Markdown / text files → `.age` (whole-file). TOML/
 * YAML/JSON → `.sops.{ext}` (per-value). */
export function encryptedPath(path: string): string {
  const ext = extname(path);
  switch (ext) {
    case ".toml":
      return path.replace(/\.toml$/, ".sops.toml");
    case ".yaml":
      return path.replace(/\.yaml$/, ".sops.yaml");
    case ".yml":
      return path.replace(/\.yml$/, ".sops.yml");
    case ".json":
      return path.replace(/\.json$/, ".sops.json");
    default:
      // Markdown, plaintext, binaries — whole-file encrypt
      return path + ".age";
  }
}
