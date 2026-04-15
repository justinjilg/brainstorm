/**
 * Team Repository — CRUD for orgs and team members.
 *
 * Manages org-level data: team membership, roles, per-user budgets.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type TeamRole =
  | "admin"
  | "engineer"
  | "qa"
  | "designer"
  | "devops"
  | "compliance";

export interface Org {
  id: string;
  name: string;
  githubOwner?: string;
  githubRepo?: string;
  settings: Record<string, unknown>;
  createdAt: number;
}

export interface TeamMember {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  role: TeamRole;
  githubUsername?: string;
  budgetDaily?: number;
  budgetMonthly?: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export class OrgRepository {
  constructor(private db: Database.Database) {}

  create(
    name: string,
    opts?: {
      githubOwner?: string;
      githubRepo?: string;
      settings?: Record<string, unknown>;
    },
  ): Org {
    const id = randomUUID().slice(0, 12);
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        "INSERT INTO orgs (id, name, github_owner, github_repo, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        name,
        opts?.githubOwner ?? null,
        opts?.githubRepo ?? null,
        JSON.stringify(opts?.settings ?? {}),
        now,
      );
    return {
      id,
      name,
      githubOwner: opts?.githubOwner,
      githubRepo: opts?.githubRepo,
      settings: opts?.settings ?? {},
      createdAt: now,
    };
  }

  get(id: string): Org | null {
    const row = this.db
      .prepare("SELECT * FROM orgs WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      githubOwner: row.github_owner,
      githubRepo: row.github_repo,
      settings: JSON.parse(row.settings_json ?? "{}"),
      createdAt: row.created_at,
    };
  }

  list(): Org[] {
    return (
      this.db
        .prepare("SELECT * FROM orgs ORDER BY created_at DESC")
        .all() as any[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      githubOwner: row.github_owner,
      githubRepo: row.github_repo,
      settings: JSON.parse(row.settings_json ?? "{}"),
      createdAt: row.created_at,
    }));
  }

  updateSettings(id: string, settings: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE orgs SET settings_json = ? WHERE id = ?")
      .run(JSON.stringify(settings), id);
  }
}

export class TeamMemberRepository {
  constructor(private db: Database.Database) {}

  add(
    orgId: string,
    member: {
      email: string;
      displayName: string;
      role?: TeamRole;
      githubUsername?: string;
      budgetDaily?: number;
      budgetMonthly?: number;
    },
  ): TeamMember {
    const id = randomUUID().slice(0, 12);
    const now = Math.floor(Date.now() / 1000);
    const role = member.role ?? "engineer";

    this.db
      .prepare(
        "INSERT INTO team_members (id, org_id, email, display_name, role, github_username, budget_daily, budget_monthly, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        orgId,
        member.email,
        member.displayName,
        role,
        member.githubUsername ?? null,
        member.budgetDaily ?? null,
        member.budgetMonthly ?? null,
        now,
        now,
      );

    return {
      id,
      orgId,
      email: member.email,
      displayName: member.displayName,
      role,
      githubUsername: member.githubUsername,
      budgetDaily: member.budgetDaily,
      budgetMonthly: member.budgetMonthly,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  list(orgId: string): TeamMember[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM team_members WHERE org_id = ? AND is_active = 1 ORDER BY role, display_name",
        )
        .all(orgId) as any[]
    ).map(toMember);
  }

  getByEmail(orgId: string, email: string): TeamMember | null {
    const row = this.db
      .prepare("SELECT * FROM team_members WHERE org_id = ? AND email = ?")
      .get(orgId, email) as any;
    return row ? toMember(row) : null;
  }

  getById(id: string): TeamMember | null {
    const row = this.db
      .prepare("SELECT * FROM team_members WHERE id = ?")
      .get(id) as any;
    return row ? toMember(row) : null;
  }

  updateRole(id: string, role: TeamRole): void {
    this.db
      .prepare(
        "UPDATE team_members SET role = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(role, id);
  }

  updateBudget(id: string, daily?: number, monthly?: number): void {
    this.db
      .prepare(
        "UPDATE team_members SET budget_daily = ?, budget_monthly = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(daily ?? null, monthly ?? null, id);
  }

  deactivate(id: string): void {
    this.db
      .prepare(
        "UPDATE team_members SET is_active = 0, updated_at = unixepoch() WHERE id = ?",
      )
      .run(id);
  }

  /** Get cost breakdown per user for an org in the current month. */
  costByUser(
    orgId: string,
  ): Array<{
    userId: string;
    email: string;
    displayName: string;
    role: string;
    totalCost: number;
    sessionCount: number;
  }> {
    const monthStart = getMonthStart();
    return this.db
      .prepare(
        `
      SELECT
        tm.id AS userId,
        tm.email,
        tm.display_name AS displayName,
        tm.role,
        COALESCE(SUM(cr.cost), 0) AS totalCost,
        COUNT(DISTINCT cr.session_id) AS sessionCount
      FROM team_members tm
      LEFT JOIN cost_records cr ON cr.user_id = tm.id AND cr.timestamp > ?
      WHERE tm.org_id = ? AND tm.is_active = 1
      GROUP BY tm.id
      ORDER BY totalCost DESC
    `,
      )
      .all(monthStart, orgId) as any[];
  }

  /** Get org-level budget totals for the current period. */
  orgBudgetSummary(orgId: string): {
    dailyCost: number;
    monthlyCost: number;
    sessionCount: number;
  } {
    const dayStart = getDayStart();
    const monthStart = getMonthStart();

    const daily =
      (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(cost), 0) AS c FROM cost_records WHERE org_id = ? AND timestamp > ?",
          )
          .get(orgId, dayStart) as any
      )?.c ?? 0;

    const monthly =
      (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(cost), 0) AS c FROM cost_records WHERE org_id = ? AND timestamp > ?",
          )
          .get(orgId, monthStart) as any
      )?.c ?? 0;

    const sessions =
      (
        this.db
          .prepare(
            "SELECT COUNT(DISTINCT session_id) AS c FROM cost_records WHERE org_id = ? AND timestamp > ?",
          )
          .get(orgId, monthStart) as any
      )?.c ?? 0;

    return { dailyCost: daily, monthlyCost: monthly, sessionCount: sessions };
  }
}

function toMember(row: any): TeamMember {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    githubUsername: row.github_username,
    budgetDaily: row.budget_daily,
    budgetMonthly: row.budget_monthly,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getDayStart(): number {
  const now = new Date();
  return Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000,
  );
}

function getMonthStart(): number {
  const now = new Date();
  return Math.floor(
    new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000,
  );
}
