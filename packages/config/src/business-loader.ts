import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import TOML from "@iarna/toml";
import { createLogger } from "@brainst0rm/shared";
import { businessTomlSchema, type BusinessToml } from "./business-schema.js";

const log = createLogger("business-harness");

/** The manifest filename detected at a harness root. */
export const BUSINESS_MANIFEST_FILE = "business.toml";

/**
 * Walk up from `cwd` looking for a `business.toml` file. Returns the absolute
 * path of the directory containing it, or `null` if no harness root is found
 * before the filesystem root.
 *
 * Modeled on git's `.git/` upward-search and on `loadHierarchicalStormFiles`
 * (storm-loader.ts:225-277). Defends against the case where users run a tool
 * from inside a sub-folder of their harness.
 */
export function findBusinessHarnessRoot(cwd: string): string | null {
  let current = resolve(cwd);
  // Hard cap to avoid pathological symlink loops; 64 levels is far past any
  // real filesystem depth.
  for (let i = 0; i < 64; i++) {
    const candidate = join(current, BUSINESS_MANIFEST_FILE);
    if (existsSync(candidate)) return current;

    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
  return null;
}

/**
 * Result of loading a business harness manifest.
 *
 * Discriminated union: callers must check `ok` before accessing `manifest`.
 * The error path is non-throwing because manifest loading is a frequent
 * lookup (every desktop session, every CLI invocation that may be inside a
 * harness) and throwing would force every caller to wrap in try/catch.
 */
export type LoadBusinessHarnessResult =
  | {
      ok: true;
      root: string;
      manifestPath: string;
      manifest: BusinessToml;
    }
  | {
      ok: false;
      root: string;
      manifestPath: string;
      error: "missing" | "parse-error" | "schema-error";
      message: string;
    };

/**
 * Load and validate the `business.toml` manifest at the given harness root.
 *
 * Tier-1 strict validation per the spec's Validation Tiers convention: a
 * malformed `business.toml` blocks the harness from opening (returns
 * `ok: false` with `error: "schema-error"` or `"parse-error"`). The desktop
 * is responsible for showing the user the diagnostic; this function never
 * throws.
 */
export function loadBusinessHarness(root: string): LoadBusinessHarnessResult {
  const manifestPath = join(root, BUSINESS_MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      root,
      manifestPath,
      error: "missing",
      message: `No ${BUSINESS_MANIFEST_FILE} at ${root}`,
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (e) {
    return {
      ok: false,
      root,
      manifestPath,
      error: "parse-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const result = businessTomlSchema.safeParse(raw);
  if (!result.success) {
    log.warn(
      { manifestPath, issues: result.error.issues },
      "business.toml failed schema validation",
    );
    return {
      ok: false,
      root,
      manifestPath,
      error: "schema-error",
      message: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  return {
    ok: true,
    root,
    manifestPath,
    manifest: result.data,
  };
}

/**
 * Convenience: walk up from cwd, then load the manifest. Used by the desktop
 * and CLI to detect "am I inside a harness?" without requiring the caller to
 * compose `findBusinessHarnessRoot` + `loadBusinessHarness`.
 */
export function detectBusinessHarness(
  cwd: string,
): LoadBusinessHarnessResult | null {
  const root = findBusinessHarnessRoot(cwd);
  if (!root) return null;
  return loadBusinessHarness(root);
}
