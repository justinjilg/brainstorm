/**
 * Cross-Project Intelligence — links per-project knowledge graphs.
 *
 * Discovers structural dependencies between projects in the Brainstorm
 * ecosystem: shared types, API contracts, shared dependencies.
 *
 * Each project has its own CodeGraph (SQLite DB). CrossProjectGraph
 * operates across them to find inter-project relationships.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CodeGraph } from "../graph.js";
import { detectApiContracts, type ApiContract } from "./api-contracts.js";
import { detectSharedTypes, type SharedType } from "./shared-types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("cross-project");

export { type ApiContract } from "./api-contracts.js";
export { type SharedType } from "./shared-types.js";

export interface CrossProjectEdge {
  sourceProject: string;
  sourceSymbol: string;
  targetProject: string;
  targetSymbol: string;
  kind: "api_call" | "shared_type" | "shared_dep";
  confidence: number;
}

export interface CrossProjectAnalysis {
  projects: string[];
  apiContracts: ApiContract[];
  sharedTypes: SharedType[];
  edges: CrossProjectEdge[];
  totalEdges: number;
}

export class CrossProjectGraph {
  private projects = new Map<string, CodeGraph>();
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path =
      dbPath ?? join(homedir(), ".brainstorm", "cross-project-graph.db");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS cross_project_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_project TEXT NOT NULL,
        source_symbol TEXT NOT NULL,
        target_project TEXT NOT NULL,
        target_symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        metadata_json TEXT
      )
    `,
      )
      .run();
    this.db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_cross_source ON cross_project_edges(source_project)",
      )
      .run();
    this.db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_cross_target ON cross_project_edges(target_project)",
      )
      .run();
  }

  /**
   * Add a project's graph to the cross-project analysis.
   */
  addProject(projectName: string, graph: CodeGraph): void {
    this.projects.set(projectName, graph);
  }

  /**
   * Run cross-project analysis across all added projects.
   */
  analyze(): CrossProjectAnalysis {
    const projectNames = Array.from(this.projects.keys());
    const allContracts: ApiContract[] = [];
    const allEdges: CrossProjectEdge[] = [];

    // Detect API contracts between every pair of projects
    for (const clientName of projectNames) {
      for (const serverName of projectNames) {
        if (clientName === serverName) continue;

        const clientGraph = this.projects.get(clientName)!;
        const serverGraph = this.projects.get(serverName)!;

        const contracts = detectApiContracts(
          clientGraph.getDb(),
          serverGraph.getDb(),
          clientName,
          serverName,
        );

        allContracts.push(...contracts);

        for (const contract of contracts) {
          allEdges.push({
            sourceProject: clientName,
            sourceSymbol: contract.clientFile,
            targetProject: serverName,
            targetSymbol: contract.path,
            kind: "api_call",
            confidence: contract.confidence,
          });
        }
      }
    }

    // Detect shared types across all projects
    const projectGraphs = projectNames.map((name) => ({
      project: name,
      db: this.projects.get(name)!.getDb(),
    }));
    const sharedTypes = detectSharedTypes(projectGraphs);

    for (const sharedType of sharedTypes) {
      // Create edges between every pair of projects that share this type
      for (let i = 0; i < sharedType.projects.length; i++) {
        for (let j = i + 1; j < sharedType.projects.length; j++) {
          allEdges.push({
            sourceProject: sharedType.projects[i].project,
            sourceSymbol: sharedType.name,
            targetProject: sharedType.projects[j].project,
            targetSymbol: sharedType.name,
            kind: "shared_type",
            confidence: 1.0,
          });
        }
      }
    }

    // Persist edges
    this.persistEdges(allEdges);

    log.info(
      {
        projects: projectNames.length,
        apiContracts: allContracts.length,
        sharedTypes: sharedTypes.length,
        totalEdges: allEdges.length,
      },
      "Cross-project analysis complete",
    );

    return {
      projects: projectNames,
      apiContracts: allContracts,
      sharedTypes,
      edges: allEdges,
      totalEdges: allEdges.length,
    };
  }

  /**
   * Find all cross-project dependencies for a given project.
   */
  getDependencies(projectName: string): CrossProjectEdge[] {
    return this.db
      .prepare(
        `
      SELECT source_project AS sourceProject, source_symbol AS sourceSymbol,
             target_project AS targetProject, target_symbol AS targetSymbol,
             kind, confidence
      FROM cross_project_edges
      WHERE source_project = ? OR target_project = ?
    `,
      )
      .all(projectName, projectName) as CrossProjectEdge[];
  }

  /**
   * Get all stored edges.
   */
  getAllEdges(): CrossProjectEdge[] {
    return this.db
      .prepare(
        `
      SELECT source_project AS sourceProject, source_symbol AS sourceSymbol,
             target_project AS targetProject, target_symbol AS targetSymbol,
             kind, confidence
      FROM cross_project_edges
    `,
      )
      .all() as CrossProjectEdge[];
  }

  close(): void {
    this.db.close();
  }

  private persistEdges(edges: CrossProjectEdge[]): void {
    // Clear old edges and insert new ones
    this.db.prepare("DELETE FROM cross_project_edges").run();

    const insert = this.db.prepare(`
      INSERT INTO cross_project_edges (source_project, source_symbol, target_project, target_symbol, kind, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const edge of edges) {
        insert.run(
          edge.sourceProject,
          edge.sourceSymbol,
          edge.targetProject,
          edge.targetSymbol,
          edge.kind,
          edge.confidence,
        );
      }
    });
    tx();
  }
}
