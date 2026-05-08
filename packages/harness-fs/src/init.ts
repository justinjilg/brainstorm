/**
 * Harness materialization — creates a fresh business harness on disk.
 *
 * Extracted from `packages/cli/src/commands/harness.ts:runInit` so that
 * both the CLI and the Electron desktop's IPC handler can call the same
 * implementation. The function is pure with respect to the calling
 * environment: no `console.log`, no `process.exit`. Errors are returned
 * as `{ ok: false, error }` results.
 *
 * Per Decision #2 (progressive bootstrap): bare init writes only the
 * manifest + identity stubs + self-describing `.harness/` metadata.
 * Optionally a fully-resolved starter template can be passed to
 * materialize archetype-specific starter files in addition to the bare
 * skeleton.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUSINESS_MANIFEST_FILE,
  BUSINESS_SCHEMA_VERSION,
  type StarterTemplate,
} from "@brainst0rm/config";

export interface MaterializeHarnessOptions {
  /** Display name (slugified for the directory). */
  name: string;
  /**
   * Archetype slug (e.g. "saas-platform"). Overridden by `template.archetype`
   * when a template is provided.
   */
  archetype: string;
  /** Parent directory; the harness lands at `<parentRoot>/<slug>`. */
  parentRoot: string;
  /**
   * Optional fully-resolved starter template. If absent, runs bare
   * progressive bootstrap (Decision #2). Caller is responsible for
   * resolving the template — this package does not depend on archetype
   * packages.
   */
  template?: StarterTemplate;
}

export type MaterializeHarnessResult =
  | {
      ok: true;
      /** Absolute path of the newly created harness root. */
      root: string;
      /** Slug derived from `name` and used as the directory name. */
      slug: string;
      /** Number of additional starter files materialized from the template (0 if no template). */
      templateFilesCreated: number;
      /** Slug of the applied template, or null if bare bootstrap. */
      templateApplied: string | null;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Slugify a business name for use as a directory name. Mirrors the
 * algorithm `runInit` used before extraction so existing CLI invocations
 * continue to land at the same paths.
 */
export function toBusinessSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function materializeHarness(
  opts: MaterializeHarnessOptions,
): MaterializeHarnessResult {
  const slug = toBusinessSlug(opts.name);
  if (!slug) {
    return {
      ok: false,
      error: `name '${opts.name}' produces an empty slug — pick something with at least one alphanumeric character`,
    };
  }
  const root = join(opts.parentRoot, slug);

  if (existsSync(join(root, BUSINESS_MANIFEST_FILE))) {
    return { ok: false, error: `harness already exists at ${root}` };
  }

  // --template overrides --archetype if both set, since each template
  // targets a specific archetype.
  const effectiveArchetype = opts.template?.archetype ?? opts.archetype;
  const template = opts.template;

  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "identity"), { recursive: true });
    mkdirSync(join(root, ".harness"), { recursive: true });

    const id = `biz_${slug.replace(/-/g, "_")}`;
    writeFileSync(
      join(root, BUSINESS_MANIFEST_FILE),
      `[identity]
id        = "${id}"
name      = "${opts.name}"
archetype = "${effectiveArchetype}"
schema    = "${BUSINESS_SCHEMA_VERSION}"

# Federation pointers — fill in as systems integrate.
# [[products]]
# slug    = "your-product"
# code    = ["~/Projects/your-product"]
# runtime = { deploy = "..." }

# [runtimes.billing]
# provider = "stripe"
# account_id = "acct_..."

[validation]
strict   = ["business.toml", "identity/identity.toml"]
lenient  = ["customers/", "products/", "operations/"]
advisory = ["**/*.md"]

[access]
sensitive = []

[ai_loops]
monthly_budget_usd      = 500
peak_run_dollars        = 50
detector_throttle_mode  = "skip"
alert_threshold_pct     = 0.8
`,
    );

    writeFileSync(
      join(root, "identity", "identity.toml"),
      `id           = "${id}"
name         = "${opts.name}"
archetype    = "${effectiveArchetype}"
status       = "active"
`,
    );
    writeFileSync(
      join(root, "identity", "mission.md"),
      `# Mission

[Replace with one or two paragraphs naming why this business exists.]

The AI's first guided-fill question will iterate on this.
`,
    );

    // Self-describing harness metadata (Decision #3 + plan item 8).
    const createdAt = new Date().toISOString();
    writeFileSync(
      join(root, ".harness", "schema.toml"),
      `# Self-describing harness metadata.
# Record what universal-skeleton version this harness was bootstrapped with
# so migration tooling knows what shape to expect.

schema_version = "${BUSINESS_SCHEMA_VERSION}"
created_at     = "${createdAt}"

# Universal seven-folder skeleton — the load-bearing structure every
# harness inherits regardless of archetype. Listed here so the migration
# tool can detect missing/extra top-level folders and prompt accordingly.
universal_folders = [
  "identity",
  "team",
  "customers",
  "products",
  "operations",
  "market",
  "governance",
]
`,
    );

    writeFileSync(
      join(root, ".harness", "archetype.toml"),
      `# Active archetype manifest.
# Records which overlay package was applied at init time (if any) and what
# files it materialized. Used by upgrade tooling to compare against newer
# archetype versions and surface drift.

archetype = "${effectiveArchetype}"
${
  template
    ? `template_slug    = "${template.slug}"
template_package = "@brainst0rm/archetype-${template.slug}"
files_materialized = ${template.files.length}`
    : `# No starter template applied — bare progressive bootstrap (Decision #2).
template_slug      = ""
files_materialized = 0`
}
applied_at = "${createdAt}"
`,
    );

    writeFileSync(
      join(root, ".harness", ".gitignore"),
      `# Local-only derived artifacts under .harness/ should not be committed.
# Per Decision #11 — index is per-user; sentinels and locks are per-machine.

index.db
index.db-*
locks/
`,
    );

    let templateFilesCreated = 0;
    if (template) {
      for (const file of template.files) {
        const abs = join(root, file.path);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, file.content);
        templateFilesCreated++;
      }
    }

    return {
      ok: true,
      root,
      slug,
      templateFilesCreated,
      templateApplied: template?.slug ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
