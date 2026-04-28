/**
 * Archetype: SaaS Platform.
 *
 * Targets a SaaS company that dogfoods the harness on itself: products,
 * customers, GTM, etc. The seven-folder skeleton fills in around the
 * federation manifest pointing at code repos.
 */

import type { StarterTemplate } from "@brainst0rm/config";

export const SAAS_PLATFORM_TEMPLATE: StarterTemplate = {
  slug: "saas-platform",
  description: "SaaS company dogfooding the harness — products, customers, GTM",
  archetype: "saas-platform",
  files: [
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
    {
      path: "market/positioning/frame.md",
      content: `# Positioning frame (cited everywhere)

[TODO: Mirror identity/narrative/positioning.md here, optimized for sales copy.]
`,
    },
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

export default SAAS_PLATFORM_TEMPLATE;
