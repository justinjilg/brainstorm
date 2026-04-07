import type { ToolPermission } from "@brainst0rm/shared";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type PermissionMode = "auto" | "confirm" | "plan";

const MODE_CYCLE: PermissionMode[] = ["auto", "confirm", "plan"];

/** Path to the persistent permissions file. */
const PERMISSIONS_FILE = join(homedir(), ".brainstorm", "permissions.json");

interface PersistedPermissions {
  allowlist: string[];
  denylist: string[];
}

/**
 * PermissionManager controls tool execution approval.
 *
 * Three modes cycle with Shift+Tab:
 * - auto: all tools execute without asking (fastest, trust the model)
 * - confirm: write/shell tools require [y/n/always] confirmation
 * - plan: only read-only tools allowed (no writes, no shell)
 *
 * Supports persistent allowlists: "always allow" decisions survive across sessions.
 * Stored in ~/.brainstorm/permissions.json and can also be set via config.toml.
 */
export class PermissionManager {
  private mode: PermissionMode;
  private sessionAlways = new Map<string, number>(); // tool → expiry timestamp
  private persistentAllowlist = new Set<string>();
  private persistentDenylist = new Set<string>();
  /** Session-level "always allow" TTL in ms. Default: 30 minutes. */
  private sessionTTLMs: number;
  /** Session start timestamp for absolute expiry. */
  private readonly sessionStartedAt = Date.now();

  constructor(
    defaultMode: PermissionMode = "confirm",
    configPermissions?: {
      allowlist?: string[];
      denylist?: string[];
      role?: "viewer" | "developer" | "admin";
      /** Session-level permission TTL in minutes. Default: 30. */
      sessionTTLMinutes?: number;
    },
  ) {
    this.sessionTTLMs = (configPermissions?.sessionTTLMinutes ?? 30) * 60_000;
    // Role presets override default mode
    if (configPermissions?.role) {
      switch (configPermissions.role) {
        case "viewer":
          this.mode = "plan";
          break;
        case "developer":
          this.mode = "confirm";
          break;
        case "admin":
          this.mode = "auto";
          break;
      }
    } else {
      this.mode = defaultMode;
    }

    // Load from config.toml permissions section
    if (configPermissions?.allowlist) {
      for (const t of configPermissions.allowlist)
        this.persistentAllowlist.add(t);
    }
    if (configPermissions?.denylist) {
      for (const t of configPermissions.denylist)
        this.persistentDenylist.add(t);
    }

    // Merge with on-disk persistence file
    const persisted = this.loadPersisted();
    for (const t of persisted.allowlist) this.persistentAllowlist.add(t);
    for (const t of persisted.denylist) this.persistentDenylist.add(t);
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Cycle to the next permission mode. */
  cycle(): PermissionMode {
    const idx = MODE_CYCLE.indexOf(this.mode);
    this.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Check if a tool is allowed to execute in the current mode.
   * Returns: 'allow' (proceed), 'confirm' (ask user), 'deny' (blocked).
   */
  check(
    toolName: string,
    toolPermission: ToolPermission,
  ): "allow" | "confirm" | "deny" {
    // Persistent denylist takes highest priority
    if (this.persistentDenylist.has(toolName)) return "deny";

    // Plan mode: only allow 'auto' (read-only) tools
    if (this.mode === "plan") {
      return toolPermission === "auto" ? "allow" : "deny";
    }

    // Tool explicitly denied in config
    if (toolPermission === "deny") return "deny";

    // Auto mode: everything allowed
    if (this.mode === "auto") return "allow";

    // Confirm mode: auto tools pass through, confirm tools need approval
    if (toolPermission === "auto") return "allow";

    // Check persistent allowlist (survives across sessions)
    if (this.persistentAllowlist.has(toolName)) return "allow";

    // Check session "always allow" list (with expiry)
    const expiry = this.sessionAlways.get(toolName);
    if (expiry !== undefined) {
      if (Date.now() < expiry) {
        return "allow";
      }
      // Expired — remove and require re-confirmation
      this.sessionAlways.delete(toolName);
    }

    return "confirm";
  }

  /** Mark a tool as "always allow" for this session (with TTL expiry). */
  alwaysAllow(toolName: string): void {
    this.sessionAlways.set(toolName, Date.now() + this.sessionTTLMs);
  }

  /** Persistently allow a tool across all future sessions. */
  persistAllow(toolName: string): void {
    this.persistentAllowlist.add(toolName);
    this.persistentDenylist.delete(toolName);
    this.savePersisted();
  }

  /** Persistently deny a tool across all future sessions. */
  persistDeny(toolName: string): void {
    this.persistentDenylist.add(toolName);
    this.persistentAllowlist.delete(toolName);
    this.savePersisted();
  }

  /** Remove a tool from both persistent lists. */
  persistRemove(toolName: string): void {
    this.persistentAllowlist.delete(toolName);
    this.persistentDenylist.delete(toolName);
    this.savePersisted();
  }

  /** Get current persistent allowlist. */
  getAllowlist(): string[] {
    return Array.from(this.persistentAllowlist);
  }

  /** Get current persistent denylist. */
  getDenylist(): string[] {
    return Array.from(this.persistentDenylist);
  }

  /** Get session "always allow" tools with their remaining TTL. */
  getSessionPermissions(): Array<{ tool: string; expiresInMs: number }> {
    const now = Date.now();
    const result: Array<{ tool: string; expiresInMs: number }> = [];
    for (const [tool, expiry] of this.sessionAlways) {
      const remaining = expiry - now;
      if (remaining > 0) {
        result.push({ tool, expiresInMs: remaining });
      } else {
        this.sessionAlways.delete(tool);
      }
    }
    return result;
  }

  /** Expire all session-level permissions (e.g., on session end or mode change). */
  expireSessionPermissions(): void {
    this.sessionAlways.clear();
  }

  /** Get the session TTL in minutes. */
  getSessionTTLMinutes(): number {
    return this.sessionTTLMs / 60_000;
  }

  private loadPersisted(): PersistedPermissions {
    try {
      if (existsSync(PERMISSIONS_FILE)) {
        const data = readFileSync(PERMISSIONS_FILE, "utf-8");
        const parsed = JSON.parse(data);
        return {
          allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
          denylist: Array.isArray(parsed.denylist) ? parsed.denylist : [],
        };
      }
    } catch {
      /* corrupted file — start fresh */
    }
    return { allowlist: [], denylist: [] };
  }

  private savePersisted(): void {
    try {
      const dir = join(homedir(), ".brainstorm");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: PersistedPermissions = {
        allowlist: Array.from(this.persistentAllowlist),
        denylist: Array.from(this.persistentDenylist),
      };
      // Atomic write: write to temp file then rename to prevent corruption on crash
      const tmpFile = PERMISSIONS_FILE + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2) + "\n");
      renameSync(tmpFile, PERMISSIONS_FILE);
    } catch {
      /* best-effort persistence */
    }
  }

  /** Get description of current mode for TUI display. */
  getModeDescription(): string {
    switch (this.mode) {
      case "auto":
        return "Auto (all tools allowed)";
      case "confirm":
        return "Confirm (approve writes/shell)";
      case "plan":
        return "Plan (read-only)";
    }
  }

  /** Get mode color for TUI. */
  getModeColor(): string {
    switch (this.mode) {
      case "auto":
        return "green";
      case "confirm":
        return "yellow";
      case "plan":
        return "cyan";
    }
  }

  /** Format a user-friendly denial message with remediation guidance. */
  formatDenialMessage(
    toolName: string,
    toolPermission: ToolPermission,
  ): string {
    const lines = [
      `BLOCKED: "${toolName}" (permission: ${toolPermission}, mode: ${this.mode})`,
    ];
    if (this.persistentDenylist.has(toolName)) {
      lines.push(`  Reason: tool is on persistent denylist`);
      lines.push(`  Fix: storm config permissions --remove-deny ${toolName}`);
    } else if (this.mode === "plan") {
      lines.push(`  Reason: plan mode only allows read-only tools`);
      lines.push(`  Fix: press Shift+Tab to switch to confirm or auto mode`);
    } else {
      lines.push(
        `  Fix: approve when prompted, or add to allowlist in config.toml`,
      );
    }
    return lines.join("\n");
  }
}
