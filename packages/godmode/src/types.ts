/**
 * God Mode Types — the contract for the connector framework.
 *
 * Every external system (BrainstormMSP, BrainstormVM, BrainstormEmailSecurity, etc.)
 * implements GodModeConnector. The framework handles auth, ChangeSet safety,
 * audit logging, tool registration, and dispatch.
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";

// ── Connector Interface ──────────────────────────────────────────

export interface GodModeConnector {
  /** Short identifier: "msp", "email", "vm", "gtm", "ops". */
  name: string;
  /** Human-readable: "BrainstormMSP", "BrainstormEmailSecurity". */
  displayName: string;
  /** What this connector can do — used for discovery + dynamic prompt building. */
  capabilities: ConnectorCapability[];
  /** Return all tools this connector provides. */
  getTools(): BrainstormToolDef[];
  /** Check if the external system is reachable. */
  healthCheck(): Promise<HealthResult>;
  /** Optional: return a system prompt segment with connector-specific intelligence. */
  getPrompt?(): string;
}

export type ConnectorCapability =
  | "endpoint-management"
  | "endpoint-security"
  | "backup"
  | "service-discovery"
  | "email-security"
  | "communication"
  | "trust-graph"
  | "quarantine"
  | "compute"
  | "storage"
  | "network"
  | "migration"
  | "marketing"
  | "lead-management"
  | "campaigns"
  | "infrastructure"
  | "dns"
  | "deployment"
  | "user-management"
  | "access-control"
  | "compliance"
  | "audit"
  | "evidence";

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

// ── Connector Configuration ──────────────────────────────────────

export interface ConnectorConfig {
  enabled: boolean;
  baseUrl: string;
  /** Vault key name for API credential. */
  apiKeyName: string;
  /** Tenant context sent to product execute calls. */
  tenantId?: string;
}

export interface GodModeConfig {
  enabled: boolean;
  /** Risk score threshold for auto-approval (0-100). Below this, no confirmation needed. */
  autoApproveRiskThreshold: number;
  /** Per-connector configs. Key is connector name ("msp", "vm", etc.). */
  connectors: Record<string, ConnectorConfig>;
  /**
   * Code Mode: register connector tools as deferred so their schemas only
   * enter the prompt after the model resolves them via `tool_search`.
   * Defaults to false to preserve the eager-load behavior current sessions
   * assume. The connector-registry sets the per-tool `deferred` flag based
   * on this value.
   */
  deferToolSchemas?: boolean;
}

// ── ChangeSet ────────────────────────────────────────────────────
//
// As of v2 (opus PR 5), ChangeSet types live in @brainst0rm/changeset-contract.
// Re-exported here so existing consumers of @brainst0rm/godmode see no
// breaking change at the import site. Direct imports from the contract
// package are preferred for new code.
//
// Migration note: ChangeSet now has a REQUIRED `tenantId` field. The
// engine's createChangeSet accepts a missing tenantId during the
// migration window (defaults to "") but emits a deprecation warning;
// callers should pass tenantId explicitly going forward.

export type {
  ChangeSet,
  ChangeSetStatus,
  Change,
  SimulationResult,
  BlastRadius,
  ChangeSetLifecycleEvent,
  CostEstimate,
  CreateChangeSetInput,
  DataClass,
  Reversibility,
} from "@brainst0rm/changeset-contract";

// ── Action Results ───────────────────────────────────────────────

export interface ActionResult {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

// ── Connection Result (from connectGodMode) ──────────────────────

export interface GodModeConnectionResult {
  /** Connectors that are healthy and registered their tools. */
  connectedSystems: Array<{
    name: string;
    displayName: string;
    capabilities: ConnectorCapability[];
    latencyMs: number;
    toolCount: number;
  }>;
  /** Connectors that failed health check. */
  errors: Array<{
    name: string;
    error: string;
  }>;
  /** System prompt segment to append. */
  promptSegment: { text: string; cacheable: boolean };
  /** Total tools registered across all connectors. */
  totalTools: number;
}
