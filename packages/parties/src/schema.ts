import { z } from "zod";

/**
 * Universal Parties Registry — schema for `governance/parties/{party-id}.toml`.
 *
 * Round 2 amendment per Codex Attack #16: real businesses contain entities
 * (Acme Ventures = customer + investor; Northstar JV = partner + customer +
 * affiliate + related party) that need a single canonical record with role
 * edges, not duplicated representations across folders.
 *
 * Each party file is one entity; the per-folder content (under
 * `customers/accounts/{slug}/`, `governance/contracts/investor/{slug}/`,
 * etc.) carries role-specific data and references back via `party_id`.
 *
 * Source-of-truth spec: ~/.claude/plans/snuggly-sleeping-hinton.md
 *   - `## Universal Parties Registry` (Round 2 amendment)
 *   - Decision #10 (Everything-Governable-is-a-File): parties satisfy all
 *     five criteria (named, lifecycle, cross-reference, governable,
 *     individually referenced)
 */

// ── Party entity type ─────────────────────────────────────
export const partyEntityTypeSchema = z.enum([
  "legal-entity",
  "individual",
  "joint-venture",
  "trust",
  "estate",
  "government",
]);

// ── Role types — extensible enum ──────────────────────────
// The five-criteria test for whether a role belongs in this enum: is it
// referenced by a folder convention in the spec? If yes, listed here. The
// `passthrough` on the role schema allows additional role-type strings for
// archetype overlays without spec changes.
export const partyRoleTypeSchema = z.enum([
  // Customer-facing roles
  "customer",
  "prospect",
  "former-customer",
  "design-partner",
  "reference",
  // Capital-table roles
  "investor",
  "stockholder",
  "lender",
  // Operational roles
  "vendor",
  "supplier",
  "partner",
  "channel-partner",
  "reseller",
  "service-provider",
  "subprocessor",
  // Workforce roles (cross-reference to workforce_class on team/humans)
  "employee",
  "contractor",
  "advisor",
  "counsel",
  "board-director",
  "board-observer",
  "investor-operator",
  "agent",
  // Family / hierarchy roles (mirrors customers/families/)
  "parent-entity",
  "subsidiary",
  "affiliate",
  // Governance / regulatory roles
  "regulator",
  "auditor",
  "common-interest-counterparty",
  // Other
  "competitor",
  "partner-of-partner",
]);

// ── Single role edge ──────────────────────────────────────
const partyRoleSchema = z
  .object({
    type: partyRoleTypeSchema,
    // Pointer to the per-folder content for this role
    folder_ref: z.string().optional(),
    // Lifecycle of this specific role (a customer can churn while the
    // party remains active as an investor)
    status: z
      .enum(["active", "pending", "paused", "ended", "archived"])
      .default("active"),
    // ISO date this role began
    since: z.string().optional(),
    // ISO date this role ended (empty/missing = ongoing)
    until: z.string().optional(),
    // Free-form fields per role: `amount` for investments, `tier` for
    // customers, `engagement_type` for partners, etc.
  })
  .passthrough();

// ── Cross-reference (typed pointer) ───────────────────────
const partyReferenceSchema = z.object({
  folder: z.string(),
  // Typing the reference helps the AI know what to expect when traversing
  type: z
    .enum([
      "captable-row",
      "contract",
      "support-account",
      "billing-account",
      "engagement",
      "audit-log",
      "litigation-matter",
      "other",
    ])
    .optional(),
  note: z.string().optional(),
});

// ── Party file schema ─────────────────────────────────────
export const partySchema = z
  .object({
    // Stable id; never renamed. Convention: party_{slug-or-nanoid}
    id: z.string().regex(/^party_[a-z0-9_-]+$/, {
      message: "id must match /^party_[a-z0-9_-]+$/",
    }),
    // Canonical short identifier for path-friendly use
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: "slug must match /^[a-z][a-z0-9-]*$/",
    }),
    // Display name (what humans see)
    display_name: z.string().min(1),
    // Full legal name; falls back to display_name when absent
    legal_name: z.string().optional(),
    // Entity classification
    type: partyEntityTypeSchema,
    // Jurisdictions where this party is registered or operates
    jurisdictions: z.array(z.string()).default([]),
    // Tax/legal id (EIN, VAT, DUNS, etc.)
    ein_or_id: z.string().optional(),
    // Date the party was first added to the registry
    created_at: z.string().optional(),
    // Lifecycle of the party itself (distinct from per-role lifecycle)
    status: z
      .enum(["active", "pending-onboarding", "dormant", "archived", "merged"])
      .default("active"),
    // If status = "merged", points at the surviving party id
    merged_into: z.string().optional(),
    // Roles this party plays — the cross-folder edge graph
    roles: z.array(partyRoleSchema).default([]),
    // Untyped references to specific files; used for free-form pointers
    references: z.array(partyReferenceSchema).default([]),
    // Free-form tags for cross-cutting filters
    tags: z.array(z.string()).default([]),
    // Last-reviewed timestamp; the AI's stale-artifact watchdog reads this
    reviewed_at: z.string().optional(),
    // Owner field (typically team/humans/{slug}) responsible for keeping
    // this party record current
    owner: z.string().optional(),
  })
  .passthrough();

export type Party = z.infer<typeof partySchema>;
export type PartyEntityType = z.infer<typeof partyEntityTypeSchema>;
export type PartyRoleType = z.infer<typeof partyRoleTypeSchema>;
export type PartyRole = z.infer<typeof partyRoleSchema>;
export type PartyReference = z.infer<typeof partyReferenceSchema>;
