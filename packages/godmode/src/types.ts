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
}

export interface GodModeConfig {
  enabled: boolean;
  /** Risk score threshold for auto-approval (0-100). Below this, no confirmation needed. */
  autoApproveRiskThreshold: number;
  /** Per-connector configs. Key is connector name ("msp", "vm", etc.). */
  connectors: Record<string, ConnectorConfig>;
}

// ── ChangeSet ────────────────────────────────────────────────────

export type ChangeSetStatus =
  | "draft"
  | "approved"
  | "executed"
  | "failed"
  | "rolled_back"
  | "rejected"
  | "expired";

export interface ChangeSet {
  id: string;
  /** Which connector created this. */
  connector: string;
  /** Tool name that created it. */
  action: string;
  /** Human-readable summary. */
  description: string;
  status: ChangeSetStatus;
  /** 0-100, auto-calculated from changes. */
  riskScore: number;
  riskFactors: string[];
  /** What will be mutated. */
  changes: Change[];
  /** Simulation of what would happen. */
  simulation: SimulationResult;
  /** Opaque undo payload from the connector. */
  rollbackData?: unknown;
  createdAt: number;
  /** 5-minute TTL on drafts. */
  expiresAt: number;
  executedAt?: number;
  /**
   * Timestamp of the transition to a terminal status (executed,
   * failed, expired, or rejected). Used as the retention anchor
   * for in-memory GC. Absent for drafts.
   */
  terminalAt?: number;
  approvedBy?: "user" | "auto";
}

export interface Change {
  /** Which system: "msp", "email", "vm". */
  system: string;
  /** Entity identifier: "device:john-laptop", "user:todd@example.com". */
  entity: string;
  operation: "create" | "update" | "delete" | "execute";
  /** Current state (from simulation). */
  before?: unknown;
  /** Projected state. */
  after?: unknown;
}

export interface SimulationResult {
  success: boolean;
  /** What the system would look like after execution. */
  statePreview: unknown;
  /** Downstream effects. */
  cascades: string[];
  /** Things that would block execution. */
  constraints: string[];
  estimatedDuration: string;
  /** Code-level blast radius from knowledge graph analysis. */
  blastRadius?: BlastRadius;
}

export interface BlastRadius {
  /** Functions/methods directly or transitively affected. */
  affectedSymbols: Array<{ name: string; file: string; depth: number }>;
  /** Community sectors affected by this change. */
  affectedCommunities: Array<{ id: string; name: string; tier: string }>;
  /** Risk multiplier — higher if critical sectors are affected. */
  riskMultiplier: number;
  /** Total number of affected symbols. */
  totalAffected: number;
}

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
