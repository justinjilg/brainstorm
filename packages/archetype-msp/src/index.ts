/**
 * Archetype: Managed Service Provider.
 *
 * Targets an MSP whose primary work is operating client environments.
 * Distinctive subtree: per-client account folders with runbooks, incidents,
 * on-call escalation, compliance posture. Plus operations/{noc,soc}.
 */

import type { StarterTemplate } from "@brainst0rm/config";

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

export default MSP_TEMPLATE;
