/**
 * Starter templates for `brainstorm harness init --template <name>`.
 *
 * Per Decision #2 (progressive bootstrap): the default `init` ships only
 * `business.toml`, `identity/identity.toml`, `identity/mission.md`, and
 * `.harness/schema.toml`. The starter templates here are an opt-in
 * power-user shortcut that pre-populate the seven-folder skeleton with
 * archetype-appropriate stubs.
 *
 * v1 archetypes shipped:
 *   - saas-platform — SaaS company dogfooding the harness on itself
 *   - msp           — Managed Service Provider with client-folder structure
 *
 * These templates intentionally include just enough that:
 *   1. The lint passes (no plaintext under sensitive globs)
 *   2. The reindex picks up real owner/tags/references for queries
 *   3. The `summary` command shows a populated dashboard
 *   4. The user has an obvious next-edit (TODO markers throughout)
 */

export interface TemplateFile {
  /** Relative path inside the harness root. */
  path: string;
  /** File content (UTF-8). */
  content: string;
}

export interface StarterTemplate {
  /** Slug used in `--template <slug>`. */
  slug: string;
  /** Human-readable description for `--help`. */
  description: string;
  /** Archetype this template targets — written into business.toml. */
  archetype: string;
  /** Files to materialize relative to harness root. */
  files: TemplateFile[];
}

export const SAAS_PLATFORM_TEMPLATE: StarterTemplate = {
  slug: "saas-platform",
  description: "SaaS company dogfooding the harness — products, customers, GTM",
  archetype: "saas-platform",
  files: [
    // Identity
    {
      path: "identity/values.md",
      content: `# Operating values

[TODO: Replace with 3–7 operating principles. Example:]

- **Customer reality over plans** — when a roadmap diverges from what customers actually need, customers win.
- **Files are the truth** — if it's not in the harness, it's not real.
- **Diligence-grade by construction** — every artifact should survive M&A diligence on day one.
`,
    },
    {
      path: "identity/narrative/positioning.md",
      content: `# Positioning frame

## Category
[TODO: name your category]

## For (target customer)
[TODO: who specifically]

## Who are frustrated with (alternatives)
[TODO: what they use today and why it falls short]

## Our product provides (capability)
[TODO: 1-sentence promise]

## Unlike (competitors)
[TODO: differentiated stance]

## We (differentiation)
[TODO: how we're different — proof points if any]
`,
    },

    // Team
    {
      path: "team/humans/founder.toml",
      content: `id           = "person_founder"
slug         = "founder"
name         = "[TODO: Your Name]"
email        = "founder@example.com"
role         = "team/roles/founder-ceo"
start_date   = "2026-01-01"
status       = "active"
owner        = "team/humans/founder"
tags         = ["founder", "active"]
`,
    },
    {
      path: "team/roles/founder-ceo.md",
      content: `# Role: Founder / CEO

[TODO: Describe scope, expected outcomes, behavioral expectations.]

## Scope
- All material decisions (per governance/policies/decision-of-authority.toml)
- Final authority on architectural changes
- Customer-facing ambassador

## Expected outcomes
- [TODO]

## Cross-references
- references = ["team/policies/code-of-conduct.md"]
`,
    },

    // Customers
    {
      path: "customers/segments/example-segment.md",
      content: `# Segment: [TODO: name]

## ICP definition
- Size: [TODO]
- Industry: [TODO]
- Use case: [TODO]

## Why we win here
[TODO]

## Anti-personas (who not to sell to)
[TODO]
`,
    },

    // Products
    {
      path: "products/example/product.toml",
      content: `id        = "prod_example"
slug      = "example"
name      = "[TODO: product name]"
status    = "active"
owner     = "team/humans/founder"
ga_date   = "2026-01-01"
tagline   = "[TODO: one-sentence promise]"
references = ["customers/segments/example-segment"]
tags       = ["active"]
`,
    },
    {
      path: "products/example/roadmap/now.md",
      content: `# Now (currently building)

[TODO: What are you shipping in the next 0-2 weeks? Bullet items.]
`,
    },
    {
      path: "products/example/roadmap/next.md",
      content: `# Next (≤2 quarters out)

[TODO: Outcome-shaped, not feature-shaped.]
`,
    },

    // Operations
    {
      path: "operations/it/tooling.toml",
      content: `# SaaS inventory — every tool we pay for, with renewal + ownership.

[[tools]]
id          = "tool_example"
name        = "Example SaaS"
provider    = "Example Inc."
purpose     = "billing"
owner       = "team/humans/founder"
cost_annual = 0
critical    = true
data_class  = []
tags        = ["operational"]
`,
    },

    // Market
    {
      path: "market/positioning/frame.md",
      content: `# Positioning frame (cited everywhere)

[TODO: Mirror identity/narrative/positioning.md here, optimized for sales copy.]
`,
    },

    // Governance
    {
      path: "governance/decisions/2026-01-01-charter.md",
      content: `+++
id        = "dec_charter"
status    = "accepted"
deciders  = ["team/humans/founder"]
date      = "2026-01-01"
tags      = ["foundational"]
+++

# Decision: Adopt the business harness as our operating substrate

## Context
We needed a single source of truth across all functional areas; existing
tools (Notion, Linear, etc.) covered slices but not the whole.

## Options Considered
1. Stay with existing stack
2. Build the harness
3. Defer

## Decision
Adopt the harness; populate progressively.

## Rationale
[TODO]

## Reversibility
Reversible — git history retains everything if we revert.

## Consequences
[TODO]
`,
    },
    {
      path: "governance/parties/example-customer.toml",
      content: `id            = "party_example_customer"
slug          = "example-customer"
display_name  = "[TODO: Example Customer Inc.]"
type          = "legal-entity"
status        = "active"
created_at    = "2026-01-01"
tags          = ["customer"]

[[roles]]
type        = "customer"
folder_ref  = "customers/accounts/example-customer"
status      = "active"
since       = "2026-01-01"
`,
    },
  ],
};

export const MSP_TEMPLATE: StarterTemplate = {
  slug: "msp",
  description: "Managed Service Provider — clients, runbooks, SOC/NOC",
  archetype: "msp",
  files: [
    {
      path: "identity/values.md",
      content: `# Operating values

[TODO]

- **Client uptime is sacred** — incidents are never "your problem".
- **Documentation is delivery** — runbooks are part of the service.
- **Compliance is a feature** — frameworks (SOC2, HIPAA) shape every offering.
`,
    },

    // MSP-specific: clients (the MSP archetype's distinctive subtree)
    {
      path: "customers/accounts/example-client/account.toml",
      content: `id              = "acct_example_client"
slug            = "example-client"
name            = "[TODO: Example Client Co.]"
status          = "active"
segment         = "customers/segments/smb-msp"
account_owner   = "team/humans/founder"
tier            = "premium"
party_id        = "party_example_client"
tags            = ["active", "premium"]
references      = []
`,
    },
    {
      path: "customers/accounts/example-client/runbooks/server-restart.md",
      content: `# Runbook: Server restart

## Pre-checks
1. Confirm scheduled-window with customer's IT lead.
2. Verify backups are current.

## Procedure
[TODO]

## Post-checks
[TODO]

## Rollback
[TODO]
`,
    },
    {
      path: "customers/accounts/example-client/incidents/.gitkeep",
      content: "",
    },
    {
      path: "customers/accounts/example-client/on-call.toml",
      content: `# Client-specific on-call escalation
primary    = "team/humans/founder"
secondary  = "team/humans/founder"  # TODO: add backup
escalation = ["team/humans/founder"]
business_hours = "09:00-18:00 America/Chicago"
`,
    },
    {
      path: "customers/accounts/example-client/compliance.toml",
      content: `frameworks_required = ["SOC2", "HIPAA"]
last_audit          = "2026-01-01"
next_audit_due      = "2027-01-01"
`,
    },

    // MSP-specific operations
    {
      path: "operations/noc/escalation.md",
      content: `# NOC escalation tree

[TODO: Define alert categories and routing.]
`,
    },
    {
      path: "operations/soc/runbook.md",
      content: `# SOC runbook

## Detection sources
[TODO]

## Severity classification
[TODO]
`,
    },

    // Team
    {
      path: "team/humans/founder.toml",
      content: `id           = "person_founder"
slug         = "founder"
name         = "[TODO: Your Name]"
role         = "team/roles/founder"
start_date   = "2026-01-01"
status       = "active"
owner        = "team/humans/founder"
tags         = ["founder"]
`,
    },
    {
      path: "team/technicians/.gitkeep",
      content: "",
    },

    // Governance
    {
      path: "governance/parties/example-client.toml",
      content: `id            = "party_example_client"
slug          = "example-client"
display_name  = "[TODO: Example Client Co.]"
type          = "legal-entity"
status        = "active"
tags          = ["customer", "msp-client"]

[[roles]]
type        = "customer"
folder_ref  = "customers/accounts/example-client"
status      = "active"
since       = "2026-01-01"
`,
    },
    {
      path: "governance/decisions/2026-01-01-charter.md",
      content: `+++
id        = "dec_charter"
status    = "accepted"
deciders  = ["team/humans/founder"]
date      = "2026-01-01"
+++

# Decision: Adopt the business harness for MSP operations

## Context
[TODO]

## Decision
Adopt the harness; client folders become the MSP's source of truth for
runbooks, incidents, and compliance posture.

## Rationale
[TODO]
`,
    },
  ],
};

export const ALL_TEMPLATES: Record<string, StarterTemplate> = {
  "saas-platform": SAAS_PLATFORM_TEMPLATE,
  msp: MSP_TEMPLATE,
};

export function getTemplate(slug: string): StarterTemplate | null {
  return ALL_TEMPLATES[slug] ?? null;
}

export function listTemplates(): Array<{ slug: string; description: string }> {
  return Object.values(ALL_TEMPLATES).map((t) => ({
    slug: t.slug,
    description: t.description,
  }));
}
