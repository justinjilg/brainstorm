/**
 * Team Context — resolves user identity and permissions from JWT claims.
 *
 * Each engineer's CLI instance carries a JWT or API key that identifies
 * them within the org. The team context determines:
 * - Which permission mode they operate in
 * - What their budget limits are
 * - Which tools they can access
 * - What gets logged to the audit trail
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("team-context");

export type TeamRole =
  | "admin"
  | "engineer"
  | "qa"
  | "designer"
  | "devops"
  | "compliance";

export interface TeamContext {
  orgId: string;
  userId: string;
  email: string;
  displayName: string;
  role: TeamRole;
  githubUsername?: string;
  budgetDaily?: number;
  budgetMonthly?: number;
}

/** Map roles to default permission modes. */
export const ROLE_PERMISSION_MODE: Record<TeamRole, string> = {
  admin: "bypass",
  engineer: "auto",
  qa: "plan",
  designer: "plan",
  devops: "auto",
  compliance: "plan",
};

/** Map roles to allowed tool patterns. */
export const ROLE_TOOL_ACCESS: Record<
  TeamRole,
  { allowed?: string[]; blocked?: string[] }
> = {
  admin: {}, // all tools
  engineer: { blocked: ["org_admin_*"] },
  qa: {
    allowed: [
      "file_read",
      "glob",
      "grep",
      "git_*",
      "code_*",
      "gov_*",
      "pr_review",
    ],
  },
  designer: {
    allowed: ["file_read", "glob", "grep", "code_search", "code_communities"],
  },
  devops: { blocked: ["org_admin_delete_*"] },
  compliance: {
    allowed: [
      "file_read",
      "glob",
      "grep",
      "gov_*",
      "code_*",
      "audit_*",
      "github_compliance_*",
    ],
  },
};

/**
 * Resolve team context from JWT claims.
 */
export function resolveTeamContext(
  claims: Record<string, unknown>,
): TeamContext | null {
  const orgId =
    (claims.platform_tenant_id as string) ?? (claims.org_id as string);
  const userId = (claims.sub as string) ?? (claims.user_id as string);
  const email = claims.email as string;
  const role =
    (claims.platform_role as TeamRole) ??
    (claims.team_role as TeamRole) ??
    "engineer";

  if (!orgId || !userId) return null;

  return {
    orgId,
    userId,
    email: email ?? "unknown",
    displayName: (claims.name as string) ?? email ?? userId,
    role,
    githubUsername: claims.github_username as string,
    budgetDaily: claims.budget_daily as number,
    budgetMonthly: claims.budget_monthly as number,
  };
}

/**
 * Get the permission mode for a team role.
 */
export function getPermissionMode(role: TeamRole): string {
  return ROLE_PERMISSION_MODE[role];
}

/**
 * Check if a role can access a specific tool.
 */
export function canAccessTool(role: TeamRole, toolName: string): boolean {
  const access = ROLE_TOOL_ACCESS[role];
  if (!access) return true;

  if (access.allowed) {
    return access.allowed.some((pattern) => {
      if (pattern.endsWith("*"))
        return toolName.startsWith(pattern.slice(0, -1));
      return toolName === pattern;
    });
  }

  if (access.blocked) {
    return !access.blocked.some((pattern) => {
      if (pattern.endsWith("*"))
        return toolName.startsWith(pattern.slice(0, -1));
      return toolName === pattern;
    });
  }

  return true;
}
