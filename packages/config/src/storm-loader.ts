import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  stormFrontmatterSchema,
  type StormFrontmatter,
} from "./storm-schema.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("storm");

const STORM_FILES = ["STORM.md", "BRAINSTORM.md"] as const;

export interface StormFile {
  /** Parsed frontmatter (null if missing or invalid) */
  frontmatter: StormFrontmatter | null;
  /** Markdown body (everything after the frontmatter block) */
  body: string;
  /** Which file was loaded */
  source: string;
}

/**
 * Load and parse a STORM.md (or BRAINSTORM.md) file.
 *
 * Lookup order: STORM.md > BRAINSTORM.md (first found wins).
 * Files without frontmatter return { frontmatter: null, body: rawContent }.
 * Invalid frontmatter logs a warning and returns null (never throws).
 */
export function loadStormFile(
  projectDir: string = process.cwd(),
): StormFile | null {
  for (const filename of STORM_FILES) {
    const filepath = join(projectDir, filename);
    if (!existsSync(filepath)) continue;

    try {
      const content = readFileSync(filepath, "utf-8");
      const { frontmatter, body } = parseStormFile(content);
      return { frontmatter, body, source: filename };
    } catch (error) {
      log.warn({ err: error, file: filename }, "Failed to read storm file");
      return null;
    }
  }

  return null;
}

/**
 * Parse a STORM.md string into frontmatter + body.
 *
 * Frontmatter is delimited by `---` on its own line.
 * Uses lightweight key-value parsing (not a full YAML parser).
 */
export function parseStormFile(content: string): {
  frontmatter: StormFrontmatter | null;
  body: string;
} {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { frontmatter: null, body: content };

  const rawYaml = fmMatch[1];
  const body = fmMatch[2].trim();

  const parsed = parseSimpleYaml(rawYaml);

  // Try strict parse first. If ALL fields are valid, use the result.
  const strict = stormFrontmatterSchema.safeParse(parsed);
  if (strict.success) {
    return { frontmatter: strict.data, body };
  }

  // Lenient fallback: peel off the failing fields one at a time and
  // re-parse with whatever remains. Previously this code returned
  // { frontmatter: null } on ANY validation failure, which meant one bad
  // field (e.g., a free-text `deploy:` value that failed the enum) would
  // silently discard ALL structured data from BRAINSTORM.md. Dogfood #1
  // surfaced this — the onboard pipeline was generating valid-looking
  // frontmatter whose `deploy` field was a free-text description, and
  // every subsequent CLI invocation silently dropped the whole thing.
  //
  // Now we keep the valid fields and drop the invalid ones. If no fields
  // survive, return null as before.
  const working: Record<string, unknown> = { ...parsed };
  const droppedFields: string[] = [];
  const MAX_ATTEMPTS = 20; // Prevent infinite loop if schema is broken
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const attempt = stormFrontmatterSchema.safeParse(working);
    if (attempt.success) {
      log.warn(
        {
          dropped: droppedFields,
          kept: Object.keys(working),
        },
        "Partial STORM.md frontmatter — kept valid fields, dropped invalid ones",
      );
      return { frontmatter: attempt.data, body };
    }
    // Pick the top-level field name from the first error path and remove it.
    const firstIssue = attempt.error.issues[0];
    const topLevelKey = firstIssue?.path[0];
    if (typeof topLevelKey !== "string" || !(topLevelKey in working)) break;
    droppedFields.push(topLevelKey);
    delete working[topLevelKey];
  }

  // Nothing survived — log and fall back to null.
  log.warn(
    {
      errors: strict.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    },
    "Invalid STORM.md frontmatter — ignoring structured data",
  );
  return { frontmatter: null, body };
}

/**
 * Lightweight YAML-subset parser for frontmatter.
 *
 * Handles: strings, numbers, booleans, arrays (inline [a, b]),
 * and one level of nesting (indented keys under a parent).
 * Not a full YAML parser — sufficient for STORM.md frontmatter.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentParent: string | null = null;
  let currentObj: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Indented key (nested under currentParent)
    const nestedMatch = line.match(/^  (\w[\w_]*)\s*:\s*(.*)$/);
    if (nestedMatch && currentParent) {
      currentObj[nestedMatch[1]] = parseValue(nestedMatch[2].trim());
      continue;
    }

    // Top-level key
    const topMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (topMatch) {
      // Flush previous nested object
      if (currentParent) {
        result[currentParent] = currentObj;
        currentParent = null;
        currentObj = {};
      }

      const key = topMatch[1];
      const value = topMatch[2].trim();

      if (value === "" || value === undefined) {
        // Start of a nested object
        currentParent = key;
        currentObj = {};
      } else {
        result[key] = parseValue(value);
      }
    }
  }

  // Flush last nested object
  if (currentParent) {
    result[currentParent] = currentObj;
  }

  return result;
}

function parseValue(raw: string): unknown {
  if (!raw) return "";

  // Inline array: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseValue(s.trim()));
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);

  // Quoted string
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Plain string
  return raw;
}

// ── Hierarchical BRAINSTORM.md Loading ─────────────────────────────

export interface HierarchicalStormResult {
  /** Merged frontmatter from the most specific file that has one. */
  frontmatter: StormFrontmatter | null;
  /** Concatenated body sections (global → project root → ... → cwd). */
  body: string;
  /** Paths of all loaded files, in order. */
  sources: string[];
}

/**
 * Load BRAINSTORM.md / STORM.md files hierarchically.
 *
 * Loading order (later = higher priority):
 * 1. ~/.brainstorm/BRAINSTORM.md (global user preferences)
 * 2. Project root BRAINSTORM.md
 * 3. Each directory from project root down to cwd
 *
 * Body sections are concatenated. Frontmatter uses the most specific
 * file that defines it (closest to cwd wins).
 */
export function loadHierarchicalStormFiles(
  projectRoot: string,
  cwd?: string,
): HierarchicalStormResult {
  const effectiveCwd = cwd ?? process.cwd();
  const sources: string[] = [];
  const bodyParts: string[] = [];
  let frontmatter: StormFrontmatter | null = null;

  // 1. Global ~/.brainstorm/BRAINSTORM.md
  const globalDir = join(homedir(), ".brainstorm");
  const globalFile = loadStormFileFromDir(globalDir);
  if (globalFile) {
    sources.push(globalFile.source);
    bodyParts.push(`# Global Preferences\n\n${globalFile.body}`);
    if (globalFile.frontmatter) frontmatter = globalFile.frontmatter;
  }

  // 2. Walk from project root to cwd, collecting BRAINSTORM.md at each level
  const resolvedRoot = resolve(projectRoot);
  const resolvedCwd = resolve(effectiveCwd);

  // Build list of directories from root to cwd (inclusive)
  const dirs: string[] = [];
  let current = resolvedCwd;
  while (current === resolvedRoot || current.startsWith(resolvedRoot + "/")) {
    dirs.push(current);
    if (current === resolvedRoot) break;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  dirs.reverse(); // root first, cwd last

  for (const dir of dirs) {
    const file = loadStormFileFromDir(dir);
    if (file) {
      const relPath =
        dir === resolvedRoot
          ? file.source
          : `${dir.slice(resolvedRoot.length + 1)}/${file.source}`;
      sources.push(relPath);
      bodyParts.push(`# Context: ${relPath}\n\n${file.body}`);
      if (file.frontmatter) frontmatter = file.frontmatter;
    }
  }

  return {
    frontmatter,
    body: bodyParts.join("\n\n---\n\n"),
    sources,
  };
}

/** Try to load a STORM.md or BRAINSTORM.md from a specific directory. */
function loadStormFileFromDir(dir: string): StormFile | null {
  for (const filename of STORM_FILES) {
    const filepath = join(dir, filename);
    if (!existsSync(filepath)) continue;

    try {
      const content = readFileSync(filepath, "utf-8");
      const { frontmatter, body } = parseStormFile(content);
      // Sanitize source path — never leak absolute paths to prompts/providers
      const safeSource = filepath.startsWith(homedir())
        ? "~" + filepath.slice(homedir().length)
        : filename;
      return { frontmatter, body, source: safeSource };
    } catch (error) {
      log.warn({ err: error, file: filepath }, "Failed to read storm file");
      return null;
    }
  }
  return null;
}
