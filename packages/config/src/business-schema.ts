import { z } from "zod";

/**
 * Zod schema for `business.toml` — the federation manifest at the root of
 * a business harness. This is the spec's `## Federation Manifest (Final
 * Shape)` section, plus amendments from Round 2 (AI-loop budget per LLM
 * Substrate Continuity; Tier 0-4 access classification per Decision #4 +
 * PQC §4.1).
 *
 * Source-of-truth spec: ~/.claude/plans/snuggly-sleeping-hinton.md
 *   - `## Federation Manifest (Final Shape)` (line ~13403)
 *   - `## Decisions Locked` (#1 archetype, #4 access tiers, #10 governable)
 *   - `## LLM Substrate Continuity` (ai_loops budget block)
 *
 * Forward-compatibility rule: unknown top-level sections are allowed via
 * `.passthrough()` so v1 manifests continue to parse under v1.5/v2 schemas
 * with new sections.
 */

// Schema version this code understands. Manifests with newer schemas fail
// strict checks unless their major version matches.
export const BUSINESS_SCHEMA_VERSION = "1.0";

// ── Archetype enum ─────────────────────────────────────────
// Decision #1: single primary archetype in v1. Hybrid (array) deferred to
// schema v2; the federation manifest accepts a string only here.
export const archetypeSchema = z.enum([
  "msp",
  "saas-platform",
  "agency",
  "marketplace",
  "ecommerce",
  "services",
]);

// ── Identity block (required) ──────────────────────────────
const identitySchema = z.object({
  // Stable id; never renamed. Convention: biz_{slug}
  id: z.string().regex(/^biz_[a-z0-9_-]+$/, {
    message: "identity.id must match /^biz_[a-z0-9_-]+$/",
  }),
  // Display name
  name: z.string().min(1),
  // Legal entity name; if absent, falls back to `name`
  legal_name: z.string().optional(),
  // The archetype overlay this harness uses
  archetype: archetypeSchema,
  // Manifest schema version (enables migration tooling)
  schema: z
    .string()
    .regex(/^\d+\.\d+$/, { message: "schema must be N.N" })
    .default(BUSINESS_SCHEMA_VERSION),
  // Founded date (ISO YYYY-MM-DD); informational
  founded: z.string().optional(),
  // Fiscal year convention
  fiscal_year: z.string().optional(),
  // Public website URL
  website: z.string().url().optional(),
  // Lifecycle status of the business itself
  status: z
    .enum(["incubating", "active", "winding-down", "archived"])
    .default("active"),
  // Reference to a team/humans/{slug}.toml owner; e.g. "team/humans/justin"
  owner: z.string().optional(),
});

// ── Product pointer ────────────────────────────────────────
// Each product is a pointer to code repos + runtime systems. Detailed
// product structure lives under `products/{slug}/` in the harness; this
// is just the federation entry.
const productPointerSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: "product slug must match /^[a-z][a-z0-9-]*$/",
    }),
    // Local paths and/or git URLs to source-code repositories
    code: z.array(z.string()).default([]),
    // Free-form runtime descriptor: { deploy: "...", api: "...", flag_provider: "..." }
    runtime: z.record(z.string(), z.unknown()).default({}),
    // Convenience field; a deploy reference (DO app id, vercel id, etc.)
    deploy: z.string().optional(),
    // Lifecycle stage (mirrors products/{slug}/lifecycle.toml#current)
    status: z
      .enum([
        "incubating",
        "alpha",
        "beta",
        "ga",
        "maintenance",
        "sunsetting",
        "sunset",
      ])
      .optional(),
  })
  .passthrough();

// ── Runtime system pointer ─────────────────────────────────
// Runtimes are keyed by dimension (msp / gtm / billing / crm / support /
// observability / etc.). Each is free-form so different providers can carry
// different connection metadata. Concrete sub-schemas live in archetype
// overlay packages (e.g. @brainst0rm/archetype-msp validates runtimes.msp).
const runtimePointerSchema = z.record(z.string(), z.unknown());

// ── External system pointer ────────────────────────────────
// External systems referenced across the harness tree (DNS, IaC, payments,
// etc.) — captured at the manifest layer so the AI knows what to dereference.
const externalSystemPointerSchema = z.record(z.string(), z.unknown());

// ── Validation tier policy ─────────────────────────────────
// Per spec's Validation Tiers convention: which paths must parse strictly
// (failure blocks load), which are lenient (failure logs but skips field),
// which are advisory (free-form, no schema).
const validationPolicySchema = z
  .object({
    strict: z.array(z.string()).default([]),
    lenient: z.array(z.string()).default([]),
    advisory: z.array(z.string()).default(["**/*.md"]),
  })
  .default({});

// ── Access classification (Tier 0-4) ───────────────────────
// Decision #4 + PQC §4.1. Tier 0 (public-by-default) and Tier 1 (private
// plaintext) are the implicit default for un-listed paths. Globs listed
// here mark paths as Tier 2 (encrypted at rest), Tier 3 (encrypted +
// restricted recipients), or Tier 4 (must be externalized — pointer only,
// no body content allowed).
//
// Naming: this block uses the words "sensitive / confidential / restricted"
// to map to PQC tier semantics: `sensitive` ≈ Tier 2, `confidential` ≈ Tier
// 2 with stricter recipient bundle, `restricted` ≈ Tier 3.
const accessPolicySchema = z
  .object({
    // Tier 2 — encrypted at rest in repo, broadly accessible to team bundle
    sensitive: z.array(z.string()).default([]),
    // Tier 2 — encrypted at rest, more restricted recipient bundle
    confidential: z.array(z.string()).default([]),
    // Tier 3 — encrypted + restricted recipients only
    restricted: z.array(z.string()).default([]),
    // Tier 4 — must be externalized; no plaintext OR encrypted body allowed
    // in repo, only pointers to external systems (Carta/Pave/Rippling/etc.)
    externalized_only: z.array(z.string()).default([]),
    // Optional alerting on sensitive-tier reads
    alerts: z
      .object({
        on_decrypt_restricted: z.boolean().default(true),
        webhook: z.string().url().optional(),
      })
      .default({}),
  })
  .default({});

// ── AI-loop budget (per LLM Substrate Continuity) ─────────
// Round 2 amendment per Codex Attack #9. Required as v1, not deferred.
const aiLoopsBudgetSchema = z
  .object({
    // Cap per harness; throttle behavior triggers at alert_threshold_pct
    monthly_budget_usd: z.number().nonnegative().default(500),
    // Per-run ceiling; exceeding fires Sev-3 alert
    peak_run_dollars: z.number().nonnegative().default(50),
    // Behavior under budget pressure
    detector_throttle_mode: z
      .enum(["skip", "sparse", "escalate"])
      .default("skip"),
    // Throttle activation threshold (0–1 of monthly_budget_usd)
    alert_threshold_pct: z.number().min(0).max(1).default(0.8),
    // Optional per-loop override file path
    overrides_file: z.string().optional(),
  })
  .default({});

// ── Master schema ──────────────────────────────────────────
// `.passthrough()` per spec's forward-compatibility rule: v1 manifests
// continue to parse under v1.5/v2 schemas with new sections.
export const businessTomlSchema = z
  .object({
    identity: identitySchema,
    // Reference to the canonical identity content folder (default `identity/`)
    identity_root: z.string().default("identity/"),
    // Products this business owns
    products: z.array(productPointerSchema).default([]),
    // Runtime systems consumed (keyed by dimension)
    runtimes: z.record(z.string(), runtimePointerSchema).default({}),
    // External systems referenced across the tree
    external_systems: z
      .record(z.string(), externalSystemPointerSchema)
      .default({}),
    // Validation tier policy
    validation: validationPolicySchema,
    // Access classification (Tier 0-4)
    access: accessPolicySchema,
    // AI-loop budget (LLM Substrate Continuity)
    ai_loops: aiLoopsBudgetSchema,
  })
  .passthrough();

export type BusinessToml = z.infer<typeof businessTomlSchema>;
export type BusinessIdentity = z.infer<typeof identitySchema>;
export type Archetype = z.infer<typeof archetypeSchema>;
export type ProductPointer = z.infer<typeof productPointerSchema>;
export type ValidationPolicy = z.infer<typeof validationPolicySchema>;
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type AiLoopsBudget = z.infer<typeof aiLoopsBudgetSchema>;
