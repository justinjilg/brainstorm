/**
 * God Mode System Prompt — dynamically built from healthy connectors.
 *
 * The prompt describes capabilities (not products), so swapping
 * CrowdStrike for SentinelOne changes a connector file, not the UX.
 */

import type {
  GodModeConfig,
  GodModeConnectionResult,
  ConnectorCapability,
} from "./types.js";

/** Map capabilities to human-readable descriptions for the prompt. */
const CAPABILITY_LABELS: Record<ConnectorCapability, string> = {
  "endpoint-management":
    "device management (status, protection, isolation, scanning)",
  "endpoint-security": "endpoint security (EDR, antivirus, compliance)",
  backup: "backup management (coverage, status, retry, health assessment)",
  "service-discovery": "asset discovery (inventory, classification, merging)",
  "email-security": "email security (threat scanning, verdicts, feedback)",
  communication: "communication management",
  "trust-graph": "trust graph analysis (identity relationships, attack paths)",
  quarantine: "message quarantine (isolate, release, bulk actions)",
  compute: "VM management (create, destroy, status, migrate)",
  storage: "storage management (volumes, snapshots, restore)",
  network: "network management (VLANs, firewalls, IPs, WireGuard)",
  migration: "live migration (cross-platform VM migration)",
  marketing: "marketing automation",
  "lead-management": "lead qualification and enrichment",
  campaigns: "campaign management (launch, status, analytics)",
  infrastructure: "infrastructure as code (Terraform plan/apply)",
  dns: "DNS management (records, propagation)",
  deployment: "deployment management",
  "user-management": "user management (status, access control)",
  "access-control": "access control (enable, disable, password reset)",
  compliance: "compliance auditing (SOC 2, HIPAA, PCI-DSS, GDPR)",
  audit: "audit logging",
  evidence: "evidence chain (cryptographic, tamper-evident)",
};

export function buildGodModePrompt(
  connected: GodModeConnectionResult["connectedSystems"],
  config: GodModeConfig,
): { text: string; cacheable: boolean } {
  if (connected.length === 0) {
    return {
      text: "## God Mode\n\nNo systems connected. Configure connectors in brainstorm.toml [godmode] section.",
      cacheable: true,
    };
  }

  const sections: string[] = [];

  sections.push(`## God Mode — Infrastructure Control Plane

You have authority over ${connected.length} connected system(s). Translate natural language into actions.`);

  // Connected systems with capabilities
  sections.push("\n### Connected Systems\n");
  for (const sys of connected) {
    const caps = sys.capabilities
      .map((c) => CAPABILITY_LABELS[c] ?? c)
      .join(", ");
    sections.push(`- **${sys.displayName}** (${sys.latencyMs}ms): ${caps}`);
  }

  // Safety protocol
  sections.push(`
### Safety Protocol

Every destructive action returns a **ChangeSet** — a simulation of what will happen. You MUST:
1. Present the ChangeSet to the user: what changes, risk score, cascades, estimated duration
2. Wait for explicit approval before calling \`gm_changeset_approve\`
3. If risk score > 50, warn the user explicitly about each risk factor
4. Never auto-approve ChangeSet execution — always present and wait
5. If the user says "no" or "cancel", call \`gm_changeset_reject\`

### Entity Resolution

Users refer to things by name ("John's computer", "the QA server"), not system IDs.
1. Call the relevant status/search/list tool to resolve the entity
2. If multiple matches, present options and ask the user to pick
3. If no match, say so and suggest alternative search terms

### Cross-System Actions

When a request involves multiple systems (e.g., "disable Todd everywhere"):
1. Identify all systems that need to act
2. Call each system's tools in sequence
3. Present a unified summary of ALL changesets before requesting approval
4. One approval gates everything`);

  return {
    text: sections.join("\n"),
    cacheable: true,
  };
}
