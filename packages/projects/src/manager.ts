/**
 * ProjectManager — high-level project operations.
 *
 * Handles registration, switching, auto-detect, budget checking,
 * and dashboard aggregation.
 */

import type Database from "better-sqlite3";
import { basename, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { Project } from "@brainstorm/shared";
import { ProjectRepository, ProjectMemoryRepository } from "./repository.js";

export interface ProjectDashboard {
  project: Project;
  sessionCount: number;
  costToday: number;
  costThisMonth: number;
  budgetDailyUsed: number; // percentage
  budgetMonthlyUsed: number; // percentage
}

export class ProjectManager {
  readonly projects: ProjectRepository;
  readonly memory: ProjectMemoryRepository;
  private activeProjectId: string | null = null;

  constructor(private db: Database.Database) {
    this.projects = new ProjectRepository(db);
    this.memory = new ProjectMemoryRepository(db);
  }

  /** Register a new project from a directory path. */
  register(
    path: string,
    name?: string,
    opts?: {
      description?: string;
      budgetDaily?: number;
      budgetMonthly?: number;
    },
  ): Project {
    const absPath = resolve(path);
    if (!existsSync(absPath)) {
      throw new Error(`Path does not exist: ${absPath}`);
    }

    // Check if already registered
    const existing = this.projects.getByPath(absPath);
    if (existing) return existing;

    const projectName = name ?? basename(absPath);

    // Check name uniqueness
    if (this.projects.getByName(projectName)) {
      throw new Error(
        `Project "${projectName}" already exists. Use --name to specify a different name.`,
      );
    }

    // Auto-detect description from BRAINSTORM.md or package.json
    let description = opts?.description ?? "";
    if (!description) {
      try {
        const pkg = JSON.parse(
          require("node:fs").readFileSync(`${absPath}/package.json`, "utf-8"),
        );
        description = pkg.description ?? "";
      } catch {
        // No package.json
      }
    }

    return this.projects.create({
      name: projectName,
      path: absPath,
      description,
      budgetDaily: opts?.budgetDaily,
      budgetMonthly: opts?.budgetMonthly,
    });
  }

  /** Switch the active project context. */
  switch(nameOrId: string): Project {
    const project =
      this.projects.getByName(nameOrId) ?? this.projects.getById(nameOrId);
    if (!project) {
      throw new Error(
        `Project "${nameOrId}" not found. Run 'storm projects list' to see registered projects.`,
      );
    }
    if (!project.isActive) {
      throw new Error(
        `Project "${project.name}" has been removed. Use 'storm projects register' to re-add it.`,
      );
    }
    this.activeProjectId = project.id;
    return project;
  }

  /** Get the currently active project, or null. */
  getActive(): Project | null {
    if (!this.activeProjectId) return null;
    return this.projects.getById(this.activeProjectId) ?? null;
  }

  /** Set active project by path (called automatically on session start). */
  activateByPath(path: string): Project | null {
    const absPath = resolve(path);
    const project = this.projects.getByPath(absPath);
    if (project) {
      this.activeProjectId = project.id;
      return project;
    }
    return null;
  }

  /** Auto-register the current directory if not already registered. */
  autoDetect(path: string): Project | null {
    const absPath = resolve(path);
    const existing = this.projects.getByPath(absPath);
    if (existing) {
      this.activeProjectId = existing.id;
      return existing;
    }

    // Only auto-register if there's a brainstorm.toml or .git directory
    const hasBrainstormConfig = existsSync(`${absPath}/brainstorm.toml`);
    const hasGit = existsSync(`${absPath}/.git`);
    if (!hasBrainstormConfig && !hasGit) return null;

    const project = this.register(absPath);
    this.activeProjectId = project.id;
    return project;
  }

  /** Scan a directory and register all subdirectories that look like projects. */
  import(parentDir: string): Project[] {
    const absDir = resolve(parentDir);
    if (!existsSync(absDir)) return [];

    const registered: Project[] = [];
    for (const entry of readdirSync(absDir)) {
      const fullPath = `${absDir}/${entry}`;
      try {
        if (!statSync(fullPath).isDirectory()) continue;
        if (entry.startsWith(".") || entry === "node_modules") continue;

        // Must have .git or brainstorm.toml to qualify
        const hasGit = existsSync(`${fullPath}/.git`);
        const hasConfig = existsSync(`${fullPath}/brainstorm.toml`);
        if (!hasGit && !hasConfig) continue;

        // Skip if already registered
        if (this.projects.getByPath(fullPath)) continue;

        const project = this.register(fullPath);
        registered.push(project);
      } catch {
        // Skip directories we can't access
      }
    }
    return registered;
  }

  /** Get dashboard summary for a project. */
  dashboard(projectId: string): ProjectDashboard | undefined {
    const project = this.projects.getById(projectId);
    if (!project) return undefined;

    const now = Math.floor(Date.now() / 1000);
    const startOfDay = now - (now % 86400);
    const startOfMonth = now - (now % (86400 * 30)); // approximate

    const costToday = this.projects.getCost(project.path, startOfDay);
    const costThisMonth = this.projects.getCost(project.path, startOfMonth);
    const sessionCount = this.projects.getSessionCount(project.id);

    return {
      project,
      sessionCount,
      costToday,
      costThisMonth,
      budgetDailyUsed: project.budgetDaily
        ? (costToday / project.budgetDaily) * 100
        : 0,
      budgetMonthlyUsed: project.budgetMonthly
        ? (costThisMonth / project.budgetMonthly) * 100
        : 0,
    };
  }

  /** Check if a project is within budget. Returns remaining budget or null if no limit. */
  checkBudget(projectId: string): {
    withinBudget: boolean;
    remaining: number | null;
    message?: string;
  } {
    const project = this.projects.getById(projectId);
    if (!project) return { withinBudget: true, remaining: null };

    const now = Math.floor(Date.now() / 1000);

    if (project.budgetDaily) {
      const startOfDay = now - (now % 86400);
      const costToday = this.projects.getCost(project.path, startOfDay);
      const remaining = project.budgetDaily - costToday;
      if (remaining <= 0) {
        return {
          withinBudget: false,
          remaining: 0,
          message: `Daily budget exceeded for "${project.name}": $${costToday.toFixed(2)} / $${project.budgetDaily.toFixed(2)}`,
        };
      }
    }

    if (project.budgetMonthly) {
      const startOfMonth = now - (now % (86400 * 30));
      const costThisMonth = this.projects.getCost(project.path, startOfMonth);
      const remaining = project.budgetMonthly - costThisMonth;
      if (remaining <= 0) {
        return {
          withinBudget: false,
          remaining: 0,
          message: `Monthly budget exceeded for "${project.name}": $${costThisMonth.toFixed(2)} / $${project.budgetMonthly.toFixed(2)}`,
        };
      }
      return { withinBudget: true, remaining };
    }

    return { withinBudget: true, remaining: null };
  }
}
