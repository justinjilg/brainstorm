import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  detectBusinessHarness,
  loadBusinessHarness,
  BUSINESS_MANIFEST_FILE,
  BUSINESS_SCHEMA_VERSION,
} from "@brainst0rm/config";
import {
  validateSensitivePaths,
  isEncryptionPipelineReady,
  encrypt,
  decrypt,
  generatePqIdentity,
  generateClassicalIdentity,
  loadRecipientBundle,
  recipientBundlePath,
  isPqHybridBundle,
  envelopePath,
  writeEnvelope,
  AuditLogWriter,
  auditLogPath,
} from "@brainst0rm/harness-crypto";
import {
  walkHarnessDir,
  detectKind,
  extractIndexFields,
  hashContent,
} from "@brainst0rm/harness-fs";
import {
  HarnessIndexStore,
  defaultIndexPath,
  ownerIndex,
  referenceGraph,
  staleArtifacts,
  dashboardSummary,
} from "@brainst0rm/harness-index";
import { getTemplate, listTemplates } from "./harness-templates.js";

/**
 * `brainstorm harness <subcommand>` — operator surface for the business
 * harness packages (config, fs, index, crypto, drift). Mirrors the spec's
 * `## Index Coherence` and `## Build-vs-Buy Case` workflow:
 *
 *   harness init <name>     — scaffold a fresh harness (Decision #2:
 *                             progressive bootstrap; manifest + identity only)
 *   harness lint            — sensitive-glob enforcement (PQC §6.3)
 *   harness reindex         — full FS walk + index repopulation
 *   harness verify          — cold-open verification report
 *   harness query           — owner / reference / stale queries
 *   harness summary         — dashboard summary at a glance
 */

export function registerHarnessCommands(program: Command): void {
  const harness = program
    .command("harness")
    .description(
      "Business harness: init / lint / reindex / verify / query / summary",
    );

  // ── init ──────────────────────────────────────────────────
  harness
    .command("init")
    .description("Scaffold a new business harness (progressive bootstrap)")
    .argument("<name>", "Business name (also used as folder name)")
    .option(
      "--archetype <slug>",
      "Archetype: msp | saas-platform | agency | marketplace | ecommerce | services",
      "saas-platform",
    )
    .option(
      "--root <path>",
      "Parent directory; defaults to ~/Businesses",
      defaultBusinessesParent(),
    )
    .option(
      "--template <slug>",
      "Use a starter template instead of progressive bootstrap. Run `brainstorm harness templates` to list.",
    )
    .action(
      async (
        name: string,
        opts: { archetype: string; root: string; template?: string },
      ) => {
        await runInit(name, opts);
      },
    );

  // ── templates ────────────────────────────────────────────
  harness
    .command("templates")
    .description("List available starter templates for `init --template`")
    .action(() => {
      console.log("Available starter templates:");
      console.log();
      for (const t of listTemplates()) {
        console.log(`  ${t.slug.padEnd(18)} ${t.description}`);
      }
      console.log();
      console.log(
        `Usage: brainstorm harness init "My Business" --template saas-platform`,
      );
    });

  // ── lint ──────────────────────────────────────────────────
  harness
    .command("lint")
    .description(
      "Validate sensitive-glob compliance and frontmatter health for the active harness",
    )
    .option(
      "--root <path>",
      "Harness root; defaults to walk-up detection from cwd",
    )
    .action(async (opts: { root?: string }) => {
      await runLint(opts);
    });

  // ── reindex ───────────────────────────────────────────────
  harness
    .command("reindex")
    .description("Full filesystem walk + index repopulation")
    .option("--root <path>", "Harness root; defaults to detection")
    .action(async (opts: { root?: string }) => {
      await runReindex(opts);
    });

  // ── verify ────────────────────────────────────────────────
  harness
    .command("verify")
    .description("Cold-open verify: check (mtime,size,hash) per indexed entry")
    .option("--root <path>", "Harness root; defaults to detection")
    .action(async (opts: { root?: string }) => {
      await runVerify(opts);
    });

  // ── query ─────────────────────────────────────────────────
  harness
    .command("query")
    .description("Run a structured query against the harness index")
    .option("--owner <ref>", "Owner reference (e.g., team/humans/justin)")
    .option("--references <target>", "Find artifacts referencing this target")
    .option(
      "--stale-days <n>",
      "Find artifacts not reviewed in the last N days",
    )
    .option("--root <path>", "Harness root; defaults to detection")
    .action(
      async (opts: {
        owner?: string;
        references?: string;
        staleDays?: string;
        root?: string;
      }) => {
        await runQuery(opts);
      },
    );

  // ── summary ───────────────────────────────────────────────
  harness
    .command("summary")
    .description("One-shot dashboard summary of the active harness")
    .option("--root <path>", "Harness root; defaults to detection")
    .action(async (opts: { root?: string }) => {
      await runSummary(opts);
    });

  // ── keygen ────────────────────────────────────────────────
  harness
    .command("keygen")
    .description(
      "Generate an age identity (PQ-hybrid by default). Writes secret key to a file you keep private; prints public key.",
    )
    .option(
      "--out <path>",
      "Path for the secret-key file",
      "./age-identity.txt",
    )
    .option(
      "--classical",
      "Generate a classical X25519 identity instead of PQ-hybrid",
      false,
    )
    .action(async (opts: { out: string; classical: boolean }) => {
      await runKeygen(opts);
    });

  // ── encrypt ───────────────────────────────────────────────
  harness
    .command("encrypt")
    .description(
      "Encrypt a file to a recipient bundle. Writes <path>.age + <path>.age.envelope.toml.",
    )
    .argument(
      "<path>",
      "File to encrypt (relative to harness root or absolute)",
    )
    .requiredOption(
      "--bundle <slug>",
      "Recipient-bundle slug (looks up .harness/recipients/{slug}.toml)",
    )
    .option(
      "--reason <text>",
      "Free-text reason for the audit log",
      "manual encrypt via CLI",
    )
    .option("--root <path>", "Harness root; defaults to detection")
    .action(
      async (
        path: string,
        opts: { bundle: string; reason: string; root?: string },
      ) => {
        await runEncrypt(path, opts);
      },
    );

  // ── decrypt ───────────────────────────────────────────────
  harness
    .command("decrypt")
    .description(
      "Decrypt an .age file using a secret-key identity. Outputs to stdout unless --out is given.",
    )
    .argument("<path>", "Encrypted file to decrypt (.age)")
    .requiredOption("--identity <path>", "Path to age secret-key file")
    .option("--out <path>", "Write decrypted content to file (default: stdout)")
    .option(
      "--reason <text>",
      "Free-text reason for the audit log",
      "manual decrypt via CLI",
    )
    .option("--root <path>", "Harness root; defaults to detection")
    .action(
      async (
        path: string,
        opts: {
          identity: string;
          out?: string;
          reason: string;
          root?: string;
        },
      ) => {
        await runDecrypt(path, opts);
      },
    );
}

// ── implementations ─────────────────────────────────────────

function defaultBusinessesParent(): string {
  return join(homedir(), "Businesses");
}

async function runInit(
  name: string,
  opts: { archetype: string; root: string; template?: string },
): Promise<void> {
  const slug = toSlug(name);
  const root = join(opts.root, slug);

  if (existsSync(join(root, BUSINESS_MANIFEST_FILE))) {
    console.error(`✗ harness already exists at ${root}`);
    process.exit(1);
  }

  // Resolve archetype: --template overrides --archetype if both set, since
  // each template targets a specific archetype.
  let effectiveArchetype = opts.archetype;
  let template = null as ReturnType<typeof getTemplate>;
  if (opts.template) {
    template = getTemplate(opts.template);
    if (!template) {
      console.error(
        `✗ unknown template '${opts.template}'. Run \`brainstorm harness templates\` to list available.`,
      );
      process.exit(1);
    }
    effectiveArchetype = template.archetype;
  }

  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "identity"), { recursive: true });
  mkdirSync(join(root, ".harness"), { recursive: true });

  // Manifest — minimum viable per Decision #2 (progressive bootstrap)
  const id = `biz_${slug.replace(/-/g, "_")}`;
  writeFileSync(
    join(root, BUSINESS_MANIFEST_FILE),
    `[identity]
id        = "${id}"
name      = "${name}"
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

  // Identity stubs — the only non-manifest files Decision #2 ships
  writeFileSync(
    join(root, "identity", "identity.toml"),
    `id           = "${id}"
name         = "${name}"
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
  // .harness/schema.toml records the universal-skeleton folder list + version
  // so future migrations know what shape this harness is on. .harness/
  // archetype.toml records which overlay package was applied (or "none" for
  // bare init).
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

  // Materialize starter-template files if --template was specified.
  // Per Decision #2: this is the "starter library" option (the shortcut
  // alternative to progressive guided fill).
  let templateFileCount = 0;
  if (template) {
    for (const file of template.files) {
      const abs = join(root, file.path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, file.content);
      templateFileCount++;
    }
  }

  console.log(`✓ initialized harness at ${root}`);
  if (template) {
    console.log(
      `  template: ${template.slug} — ${templateFileCount} starter files materialized`,
    );
  }
  console.log(
    `  next: cd ${root} && brainstorm harness reindex && brainstorm harness summary`,
  );
}

async function runLint(opts: { root?: string }): Promise<void> {
  const root = resolveRoot(opts.root);
  const loaded = loadBusinessHarness(root);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error}: ${loaded.message}`);
    process.exit(1);
  }
  const manifest = loaded.manifest;
  const sensitiveGlobs = [
    ...manifest.access.sensitive,
    ...manifest.access.confidential,
    ...manifest.access.restricted,
  ];

  const walk = walkHarnessDir(root);
  const violations = validateSensitivePaths(
    walk.artifacts.map((a) => a.relativePath),
    sensitiveGlobs,
  );

  console.log(
    `harness:    ${manifest.identity.name} (${manifest.identity.archetype})`,
  );
  console.log(`root:       ${root}`);
  console.log(
    `walked:     ${walk.total_files_seen} files (${formatBytes(walk.total_bytes)}) in ${walk.duration_ms}ms`,
  );
  console.log(`parse-err:  ${walk.parse_errors.length}`);

  if (walk.parse_errors.length > 0) {
    console.log();
    console.log("parse errors:");
    for (const err of walk.parse_errors.slice(0, 10)) {
      console.log(`  ${err.path}: ${err.error}`);
    }
    if (walk.parse_errors.length > 10) {
      console.log(`  …and ${walk.parse_errors.length - 10} more`);
    }
  }

  if (violations.length > 0) {
    console.log();
    console.log(
      `✗ ${violations.length} sensitive-path violation(s) (plaintext under sensitive glob):`,
    );
    for (const v of violations) {
      console.log(`  ${v.path}  →  ${v.matched_glob} (${v.reason})`);
    }
    process.exit(1);
  }

  console.log();
  console.log(
    `encryption pipeline ready: ${await isEncryptionPipelineReady()}`,
  );
  console.log(`✓ lint clean`);
}

async function runReindex(opts: { root?: string }): Promise<void> {
  const root = resolveRoot(opts.root);
  const harnessId = harnessIdFromRoot(root);
  const store = new HarnessIndexStore(defaultIndexPath(harnessId));
  try {
    const walk = walkHarnessDir(root);
    const seenPaths = new Set<string>();
    let upserts = 0;
    for (const artifact of walk.artifacts) {
      const fields = extractIndexFields(artifact.frontmatter);
      store.upsertArtifact({
        relative_path: artifact.relativePath,
        mtime_ms: artifact.mtime_ms,
        size_bytes: artifact.size_bytes,
        content_hash: artifact.content_hash,
        artifact_kind: detectKind(artifact.relativePath, artifact.frontmatter),
        owner: fields.owner,
        status: fields.status,
        reviewed_at: fields.reviewed_at,
        tags: fields.tags,
        references: fields.references,
      });
      seenPaths.add(artifact.relativePath);
      upserts++;
    }

    // Prune entries whose files were deleted from disk between reindexes.
    // Closes the soft-delete-on-disk-but-index-knows-about-it failure mode
    // (gap_2026-04-28-reindex-doesnt-prune-deleted).
    let pruned = 0;
    for (const row of store.allArtifacts()) {
      if (!seenPaths.has(row.relative_path)) {
        store.removeArtifact(row.relative_path);
        pruned++;
      }
    }

    console.log(
      `✓ indexed ${upserts} artifact(s) in ${walk.duration_ms}ms (${walk.parse_errors.length} parse error(s))`,
    );
    if (pruned > 0) {
      console.log(`  pruned ${pruned} deleted file(s) from index`);
    }
    console.log(`  index db: ${defaultIndexPath(harnessId)}`);
  } finally {
    store.close();
  }
}

async function runVerify(opts: { root?: string }): Promise<void> {
  const root = resolveRoot(opts.root);
  const harnessId = harnessIdFromRoot(root);
  const store = new HarnessIndexStore(defaultIndexPath(harnessId));
  try {
    const result = store.coldOpenVerify(root);
    console.log(`clean:      ${result.clean}`);
    console.log(`stale:      ${result.stale.length}`);
    console.log(`missing:    ${result.missing.length}`);
    if (result.stale.length > 0) {
      console.log();
      console.log("stale (changed since indexed):");
      for (const p of result.stale.slice(0, 20)) console.log(`  ${p}`);
      if (result.stale.length > 20) {
        console.log(`  …and ${result.stale.length - 20} more`);
      }
    }
    if (result.missing.length > 0) {
      console.log();
      console.log("missing (file gone):");
      for (const p of result.missing.slice(0, 20)) console.log(`  ${p}`);
      if (result.missing.length > 20) {
        console.log(`  …and ${result.missing.length - 20} more`);
      }
    }
  } finally {
    store.close();
  }
}

async function runQuery(opts: {
  owner?: string;
  references?: string;
  staleDays?: string;
  root?: string;
}): Promise<void> {
  const root = resolveRoot(opts.root);
  const harnessId = harnessIdFromRoot(root);
  const store = new HarnessIndexStore(defaultIndexPath(harnessId));
  try {
    if (opts.owner) {
      const summary = ownerIndex(store, opts.owner);
      console.log(`owner: ${summary.owner}`);
      console.log(`total: ${summary.total}`);
      console.log(`by kind:`);
      for (const [k, n] of Object.entries(summary.by_kind)) {
        console.log(`  ${k.padEnd(12)} ${n}`);
      }
      console.log();
      for (const a of summary.artifacts.slice(0, 30)) {
        console.log(`  ${a.relative_path}`);
      }
      if (summary.artifacts.length > 30) {
        console.log(`  …and ${summary.artifacts.length - 30} more`);
      }
      return;
    }

    if (opts.references) {
      const graph = referenceGraph(store, opts.references);
      console.log(`target: ${graph.target}`);
      console.log(`inbound: ${graph.inbound_count}`);
      console.log();
      for (const a of graph.inbound) {
        console.log(`  ${a.relative_path}`);
      }
      return;
    }

    if (opts.staleDays) {
      const days = Number.parseInt(opts.staleDays, 10);
      if (!Number.isFinite(days) || days < 0) {
        console.error("✗ --stale-days must be a non-negative integer");
        process.exit(1);
      }
      const summary = staleArtifacts(store, days);
      console.log(`stale (older than ${days}d): ${summary.count}`);
      console.log(`by kind:`);
      for (const [k, n] of Object.entries(summary.by_kind)) {
        console.log(`  ${k.padEnd(12)} ${n}`);
      }
      console.log();
      for (const a of summary.artifacts.slice(0, 30)) {
        console.log(
          `  ${a.relative_path}  (reviewed: ${a.reviewed_at ? new Date(a.reviewed_at).toISOString() : "never"})`,
        );
      }
      return;
    }

    console.error("✗ provide one of --owner, --references, or --stale-days");
    process.exit(1);
  } finally {
    store.close();
  }
}

async function runSummary(opts: { root?: string }): Promise<void> {
  const root = resolveRoot(opts.root);
  const loaded = loadBusinessHarness(root);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error}: ${loaded.message}`);
    process.exit(1);
  }
  const harnessId = harnessIdFromRoot(root);
  const store = new HarnessIndexStore(defaultIndexPath(harnessId));
  try {
    const summary = dashboardSummary(store);
    console.log(
      `harness:    ${loaded.manifest.identity.name}  (${loaded.manifest.identity.archetype})`,
    );
    console.log(`root:       ${root}`);
    console.log(`artifacts:  ${summary.total_artifacts}`);
    console.log(`by kind:`);
    for (const [k, n] of Object.entries(summary.total_by_kind)) {
      console.log(`  ${k.padEnd(12)} ${n}`);
    }
    console.log(`owners:     ${summary.total_owners}`);
    if (summary.top_owners.length > 0) {
      console.log(`top owners:`);
      for (const o of summary.top_owners.slice(0, 5)) {
        console.log(`  ${o.owner.padEnd(28)} ${o.count}`);
      }
    }
    if (summary.top_tags.length > 0) {
      console.log(`top tags:`);
      for (const t of summary.top_tags.slice(0, 5)) {
        console.log(`  ${t.tag.padEnd(20)} ${t.count}`);
      }
    }
    console.log(`stale (30d): ${summary.stale_30d.count}`);
    console.log(`drift open:  ${summary.unresolved_drift_count}`);
  } finally {
    store.close();
  }
}

// ── shared helpers ──────────────────────────────────────────

function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  const detected = detectBusinessHarness(process.cwd());
  if (!detected) {
    console.error(
      "✗ no business.toml found walking up from cwd; pass --root <path>",
    );
    process.exit(1);
  }
  return detected.root;
}

function harnessIdFromRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── keygen / encrypt / decrypt ──────────────────────────────

async function runKeygen(opts: {
  out: string;
  classical: boolean;
}): Promise<void> {
  const ready = await isEncryptionPipelineReady();
  if (!ready) {
    console.error(
      "✗ encryption pipeline not ready (age + age-keygen must be on $PATH).",
    );
    console.error(
      "  install with `brew install age` (macOS) or your package manager.",
    );
    process.exit(1);
  }

  const id = opts.classical
    ? await generateClassicalIdentity()
    : await generatePqIdentity();

  if (existsSync(opts.out)) {
    console.error(`✗ refuse to overwrite existing file: ${opts.out}`);
    console.error("  pass --out <new-path> or move the existing file first.");
    process.exit(1);
  }

  writeFileSync(opts.out, id.secret_key + "\n", { mode: 0o600 });
  console.log(`✓ identity generated`);
  console.log(
    `  type:       ${opts.classical ? "classical X25519" : "PQ-hybrid (ML-KEM-768 + X25519)"}`,
  );
  console.log(`  secret key: ${opts.out}  (chmod 600 — keep this secret!)`);
  console.log(`  public key: ${id.public_key}`);
  console.log();
  console.log(`Add the public key to a recipient bundle:`);
  console.log(
    `  .harness/recipients/<bundle>.toml under [[recipients]] public_key = "..."`,
  );
}

async function runEncrypt(
  path: string,
  opts: { bundle: string; reason: string; root?: string },
): Promise<void> {
  const root = resolveRoot(opts.root);
  const ready = await isEncryptionPipelineReady();
  if (!ready) {
    console.error("✗ encryption pipeline not ready — install age first.");
    process.exit(1);
  }

  const bundlePath = recipientBundlePath(root, opts.bundle);
  if (!existsSync(bundlePath)) {
    console.error(`✗ bundle not found: ${bundlePath}`);
    console.error(`  create it under .harness/recipients/${opts.bundle}.toml`);
    process.exit(1);
  }

  const loaded = loadRecipientBundle(bundlePath);
  if (!loaded.ok) {
    console.error(`✗ bundle ${opts.bundle} failed to parse: ${loaded.error}`);
    if ("message" in loaded) console.error(`  ${loaded.message}`);
    process.exit(1);
  }

  // Resolve the input path relative to harness root if not absolute.
  const inputPath = path.startsWith("/") ? path : join(root, path);
  if (!existsSync(inputPath)) {
    console.error(`✗ input file not found: ${inputPath}`);
    process.exit(1);
  }

  const plaintext = readFileSync(inputPath);
  const outputPath = `${inputPath}.age`;
  if (existsSync(outputPath)) {
    console.error(`✗ refuse to overwrite existing ciphertext: ${outputPath}`);
    process.exit(1);
  }

  const audit = {
    actor_type: "human" as const,
    actor_ref: process.env.USER
      ? `team/humans/${process.env.USER}`
      : "team/humans/unknown",
    reason: opts.reason,
    at: new Date().toISOString(),
  };

  const result = await encrypt({
    outputPath,
    plaintext,
    bundle: loaded.bundle,
    audit,
  });

  // Write the envelope companion file (PQC §4.5)
  writeEnvelope(outputPath, {
    artifact: outputPath.slice(root.length + 1),
    plaintext_sha256: result.plaintext_sha256,
    ciphertext_sha256: result.ciphertext_sha256,
    bundles_used: [`${result.bundle_id}@v${result.bundle_version}`],
    signer: audit.actor_ref,
    created_at: audit.at,
    schema: "harness.encrypt.v1",
  });

  // Append to the audit log (constructor mkdir's the dir if missing)
  const log = new AuditLogWriter(auditLogPath(root));
  log.append({
    kind: "encrypt",
    at: audit.at,
    actor_type: audit.actor_type,
    actor_ref: audit.actor_ref,
    reason: audit.reason,
    artifact_path: outputPath.slice(root.length + 1),
    bundle_id: result.bundle_id,
    plaintext_sha256: result.plaintext_sha256,
  });

  const pq = isPqHybridBundle(loaded.bundle) ? " (PQ-hybrid)" : "";
  console.log(`✓ encrypted${pq}`);
  console.log(`  ciphertext: ${outputPath}`);
  console.log(`  envelope:   ${envelopePath(outputPath)}`);
  console.log(
    `  bundle:     ${result.bundle_id}@v${result.bundle_version}  (${loaded.bundle.recipients.length} recipient${loaded.bundle.recipients.length === 1 ? "" : "s"})`,
  );
  console.log();
  console.log(`Source plaintext is unchanged. Delete it manually if intended:`);
  console.log(`  rm ${inputPath}`);
}

async function runDecrypt(
  path: string,
  opts: {
    identity: string;
    out?: string;
    reason: string;
    root?: string;
  },
): Promise<void> {
  const root = resolveRoot(opts.root);
  const ready = await isEncryptionPipelineReady();
  if (!ready) {
    console.error("✗ encryption pipeline not ready — install age first.");
    process.exit(1);
  }

  const inputPath = path.startsWith("/") ? path : join(root, path);
  if (!existsSync(inputPath)) {
    console.error(`✗ encrypted file not found: ${inputPath}`);
    process.exit(1);
  }
  if (!existsSync(opts.identity)) {
    console.error(`✗ identity file not found: ${opts.identity}`);
    process.exit(1);
  }

  const audit = {
    actor_type: "human" as const,
    actor_ref: process.env.USER
      ? `team/humans/${process.env.USER}`
      : "team/humans/unknown",
    reason: opts.reason,
    at: new Date().toISOString(),
  };

  const result = await decrypt({
    encryptedPath: inputPath,
    identity: {
      id: basename(opts.identity),
      identity_file: opts.identity,
      hardware_backed: false,
    },
    audit,
  });

  // Append to audit log before emitting plaintext, so the read is recorded
  // even if the operator pipes to a tool that crashes mid-stream.
  const log = new AuditLogWriter(auditLogPath(root));
  log.append({
    kind: "decrypt",
    at: audit.at,
    actor_type: audit.actor_type,
    actor_ref: audit.actor_ref,
    reason: audit.reason,
    artifact_path: inputPath.slice(root.length + 1),
    bundle_id: result.bundle_id ?? undefined,
    plaintext_sha256: result.plaintext_sha256,
  });

  if (opts.out) {
    writeFileSync(opts.out, result.plaintext);
    console.error(`✓ decrypted to ${opts.out}`);
    console.error(`  plaintext_sha256: ${result.plaintext_sha256}`);
  } else {
    process.stdout.write(result.plaintext);
  }
}
