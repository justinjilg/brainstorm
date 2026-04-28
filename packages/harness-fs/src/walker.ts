import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import TOML from "@iarna/toml";
import { hashContent } from "./write-through.js";

/**
 * Directory walker for harness initial population.
 *
 * Per spec `## Index Coherence and Drift Architecture` performance budget:
 *   - Full re-index: ≤120s for 20k files. Walker depth-first; no async I/O
 *     since Node sync FS is fastest in tight loops at this scale.
 *
 * Skips ignore globs by path prefix (cheap), not minimatch (expensive at
 * 20k+ files). Default ignore set matches the watcher's; override via
 * `ignoredDirs`.
 *
 * The walker doesn't directly write to the index — it yields
 * `WalkedArtifact` records that the caller maps to its index schema.
 * This keeps the walker pure (testable without a database) and lets
 * archetype overlays plug their own parsers in without modifying the
 * walker.
 */

export interface WalkedArtifact {
  /** Absolute path. */
  absolutePath: string;
  /** Path relative to harness root (canonical index key). */
  relativePath: string;
  /** mtimeMs from fs.stat. */
  mtime_ms: number;
  /** size from fs.stat. */
  size_bytes: number;
  /** SHA-256 of file content. */
  content_hash: string;
  /** TOML/markdown frontmatter if parseable. Best-effort: parse errors
   *  return null and surface in the WalkResult.errors list. */
  frontmatter: Record<string, unknown> | null;
  /** Detected artifact kind hint based on path: "human" | "agent" |
   *  "account" | "product" | "decision" | "contract" | "party" | "other".
   *  This is heuristic; parsers can override based on schema_version etc. */
  kind: ArtifactKind;
}

export type ArtifactKind =
  | "human"
  | "agent"
  | "account"
  | "product"
  | "decision"
  | "contract"
  | "party"
  | "policy"
  | "okr"
  | "manifest"
  | "other";

export interface WalkOptions {
  /** Top-level directories to skip. Path-prefix match, not glob. Defaults
   *  cover common cases: .harness/index, .harness/locks, .git, node_modules,
   *  dist, .DS_Store. */
  ignoredDirs?: string[];
  /** File extensions to attempt to parse. Defaults: .toml, .md.
   *  Anything outside is hashed but frontmatter remains null. */
  parseExtensions?: string[];
  /** Maximum depth to recurse. Default 12 — far past any reasonable
   *  harness layout, defends against pathological symlink loops. */
  maxDepth?: number;
}

export interface WalkResult {
  /** All walked artifacts with parsed metadata where available. */
  artifacts: WalkedArtifact[];
  /** Files that hit a parse error (TOML malformed, etc.). The walker
   *  doesn't fail-closed on these — the file is still hashed and indexed,
   *  just without frontmatter. */
  parse_errors: Array<{ path: string; error: string }>;
  /** Counts for budget reporting. */
  total_files_seen: number;
  total_dirs_seen: number;
  total_bytes: number;
  duration_ms: number;
}

const DEFAULT_IGNORED_DIRS = [
  ".harness/index",
  ".harness/locks",
  ".git",
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".vite",
];

const DEFAULT_PARSE_EXTENSIONS = [".toml", ".md"];

export function walkHarnessDir(
  harnessRoot: string,
  options: WalkOptions = {},
): WalkResult {
  const ignored = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const parseExts = options.parseExtensions ?? DEFAULT_PARSE_EXTENSIONS;
  const maxDepth = options.maxDepth ?? 12;

  const startedAt = Date.now();
  const result: WalkResult = {
    artifacts: [],
    parse_errors: [],
    total_files_seen: 0,
    total_dirs_seen: 0,
    total_bytes: 0,
    duration_ms: 0,
  };

  const queue: Array<{ dir: string; depth: number }> = [
    { dir: harnessRoot, depth: 0 },
  ];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable dir — skip
    }
    result.total_dirs_seen++;

    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(harnessRoot, abs);

      // Path-prefix ignore check (cheap)
      const shouldSkip = Array.from(ignored).some(
        (p) => rel === p || rel.startsWith(p + "/"),
      );
      if (shouldSkip) continue;

      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue; // broken symlink or perm error — skip
      }

      if (stats.isDirectory()) {
        queue.push({ dir: abs, depth: depth + 1 });
      } else if (stats.isFile()) {
        result.total_files_seen++;
        result.total_bytes += stats.size;

        let buffer: Buffer;
        try {
          buffer = readFileSync(abs);
        } catch {
          continue;
        }

        const content_hash = hashContent(buffer);
        const ext = extOf(name);
        let frontmatter: Record<string, unknown> | null = null;

        if (parseExts.includes(ext)) {
          if (ext === ".toml") {
            try {
              frontmatter = TOML.parse(buffer.toString("utf-8")) as Record<
                string,
                unknown
              >;
            } catch (e) {
              result.parse_errors.push({
                path: rel,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          } else if (ext === ".md") {
            frontmatter = parseMarkdownFrontmatter(buffer.toString("utf-8"));
          }
        }

        result.artifacts.push({
          absolutePath: abs,
          relativePath: rel,
          mtime_ms: stats.mtimeMs,
          size_bytes: stats.size,
          content_hash,
          frontmatter,
          kind: detectKind(rel, frontmatter),
        });
      }
    }
  }

  result.duration_ms = Date.now() - startedAt;
  return result;
}

/**
 * Heuristic artifact-kind detection from path + parsed frontmatter.
 * Used to populate `artifact_kind` in the index without requiring every
 * caller to write a switch statement. Parsers may override.
 */
export function detectKind(
  relativePath: string,
  frontmatter: Record<string, unknown> | null,
): ArtifactKind {
  // Path-based heuristics first (fast, deterministic)
  if (relativePath === "business.toml") return "manifest";
  if (relativePath.startsWith("team/humans/") && relativePath.endsWith(".toml"))
    return "human";
  if (relativePath.startsWith("team/agents/") && relativePath.endsWith(".toml"))
    return "agent";
  if (
    relativePath.startsWith("customers/accounts/") &&
    relativePath.endsWith("account.toml")
  )
    return "account";
  if (
    relativePath.startsWith("products/") &&
    relativePath.endsWith("product.toml")
  )
    return "product";
  if (
    relativePath.startsWith("governance/decisions/") &&
    relativePath.endsWith(".md")
  )
    return "decision";
  if (
    relativePath.startsWith("governance/contracts/") &&
    (relativePath.endsWith(".md") || relativePath.endsWith(".md.age"))
  )
    return "contract";
  if (
    relativePath.startsWith("governance/parties/") &&
    relativePath.endsWith(".toml")
  )
    return "party";
  if (
    relativePath.startsWith("team/policies/") ||
    relativePath.startsWith("operations/security/policies/")
  )
    return "policy";
  if (relativePath.includes("/okrs/")) return "okr";

  // Frontmatter hints
  if (frontmatter) {
    const id = frontmatter.id as string | undefined;
    if (id?.startsWith("party_")) return "party";
    if (id?.startsWith("acct_")) return "account";
    if (id?.startsWith("person_")) return "human";
    if (id?.startsWith("agent_")) return "agent";
    if (id?.startsWith("prod_")) return "product";
    if (id?.startsWith("dec_")) return "decision";
  }

  return "other";
}

/**
 * Extract owner/tags/references from parsed frontmatter for the index.
 * Mirrors the spec's `Cross-cutting concepts` (line ~46): every governable
 * entity carries `owner`, `tags`, `references`.
 */
export function extractIndexFields(
  frontmatter: Record<string, unknown> | null,
): {
  owner: string | null;
  tags: string[];
  references: Array<{ target: string; type?: string }>;
  status: string | null;
  reviewed_at: number | null;
} {
  if (!frontmatter) {
    return {
      owner: null,
      tags: [],
      references: [],
      status: null,
      reviewed_at: null,
    };
  }
  return {
    owner: typeof frontmatter.owner === "string" ? frontmatter.owner : null,
    tags: Array.isArray(frontmatter.tags)
      ? frontmatter.tags.filter((t): t is string => typeof t === "string")
      : [],
    references: extractReferences(frontmatter.references),
    status: typeof frontmatter.status === "string" ? frontmatter.status : null,
    reviewed_at: parseDateMs(frontmatter.reviewed_at),
  };
}

function extractReferences(
  raw: unknown,
): Array<{ target: string; type?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { target: entry };
      if (entry && typeof entry === "object" && "target" in entry) {
        const obj = entry as { target: unknown; type?: unknown };
        if (typeof obj.target === "string") {
          return {
            target: obj.target,
            type: typeof obj.type === "string" ? obj.type : undefined,
          };
        }
      }
      return null;
    })
    .filter((r): r is { target: string; type?: string } => r !== null);
}

function parseDateMs(raw: unknown): number | null {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx);
}

/**
 * Light-weight markdown frontmatter parser. Recognizes both `---`-fenced
 * YAML frontmatter and `+++`-fenced TOML frontmatter (per the spec's
 * convention in the gap protocol §2 and ADR template).
 */
function parseMarkdownFrontmatter(
  content: string,
): Record<string, unknown> | null {
  const lines = content.split(/\r?\n/);
  if (lines.length < 3) return null;

  const fence = lines[0];
  if (fence !== "---" && fence !== "+++") return null;

  const closeIdx = lines.findIndex((line, i) => i > 0 && line === fence);
  if (closeIdx === -1) return null;

  const block = lines.slice(1, closeIdx).join("\n");
  if (fence === "+++") {
    try {
      return TOML.parse(block) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  // `---` YAML — we don't ship a YAML parser in harness-fs; stub-extract
  // simple key: value pairs only. Caller can hand off to a real YAML
  // parser if richer fields are needed.
  return parseSimpleYamlPairs(block);
}

function parseSimpleYamlPairs(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
