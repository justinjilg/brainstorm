/**
 * Governance MCP Tools — expose traceability, validation, and analytics
 * as MCP tools for external AI editors (Cursor, Windsurf, Codex).
 *
 * These tools let any MCP-compatible editor access Brainstorm's governance
 * features without switching to the Brainstorm CLI.
 */

import { z } from "zod";
import type Database from "better-sqlite3";
// Import from source modules directly, NOT through `./index.js`. Pass
// 32 dep-cruiser caught a cycle: index.ts re-exports mcp-tools, and
// mcp-tools was importing from index — a classic barrel-through-sibling
// loop. Going to the source module breaks the cycle without changing
// semantics.
import {
  listArtifacts,
  traceChain,
  getCoverageMetrics,
  saveArtifact,
} from "./store.js";
import {
  generateTraceId,
  type TracedArtifact,
  type ArtifactType,
} from "./trace-id.js";
import { validate, type ValidationRules } from "./validate.js";
import {
  generateAnalyticsReport,
  formatAnalyticsMarkdown,
} from "./analytics.js";

type McpServer = {
  tool(
    name: string,
    description: string,
    schema: Record<string, any>,
    handler: (params: any) => Promise<any>,
  ): void;
};

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Register governance MCP tools on a server instance.
 */
export function registerGovernanceMCPTools(
  server: McpServer,
  db: Database.Database,
  project: string,
  graph?: any,
): number {
  // ── 1. gov_validate — Run deterministic validation ─────────────
  server.tool(
    "gov_validate",
    "Run deterministic validation on the project — no LLM. Checks traceability, test coverage, blast radius, conventions. Returns pass/fail with score.",
    {
      requireTraceability: z
        .boolean()
        .optional()
        .describe("Require all changes trace to requirements (default true)"),
      requireTestCoverage: z
        .boolean()
        .optional()
        .describe("Require all requirements have tests (default false)"),
      maxBlastRadius: z
        .number()
        .optional()
        .describe("Maximum allowed blast radius (default 50)"),
    },
    async (params) => {
      const rules: ValidationRules = {
        requireTraceability: params.requireTraceability,
        requireTestCoverage: params.requireTestCoverage,
        maxBlastRadius: params.maxBlastRadius,
      };
      const result = validate(db, project, rules, graph);
      return textResult(result);
    },
  );

  // ── 2. gov_trace — Trace artifact chain ────────────────────────
  server.tool(
    "gov_trace",
    "Trace the full chain from a requirement to code changes and tests. Shows every linked artifact upstream or downstream.",
    {
      traceId: z
        .string()
        .describe("TraceId to follow (e.g., REQ-brainstorm-001)"),
      direction: z
        .enum(["downstream", "upstream"])
        .optional()
        .describe("Direction to trace (default downstream)"),
    },
    async ({ traceId, direction }) => {
      const chain = traceChain(db, traceId, direction ?? "downstream");
      return textResult({
        origin: traceId,
        direction: direction ?? "downstream",
        chain: chain.map((a) => ({
          traceId: a.traceId,
          type: a.type,
          title: a.title,
          status: a.status,
        })),
        count: chain.length,
      });
    },
  );

  // ── 3. gov_coverage — Traceability coverage metrics ────────────
  server.tool(
    "gov_coverage",
    "Get traceability coverage metrics — requirement test coverage, change trace coverage, and design decision count.",
    {},
    async () => {
      const metrics = getCoverageMetrics(db, project);
      return textResult(metrics);
    },
  );

  // ── 4. gov_artifacts — List traced artifacts ───────────────────
  server.tool(
    "gov_artifacts",
    "List all traced artifacts (requirements, designs, plans, changes, tests) with optional type filter.",
    {
      type: z
        .enum(["REQ", "DES", "PLN", "CHG", "TST", "ADR"])
        .optional()
        .describe("Filter by artifact type"),
      status: z
        .string()
        .optional()
        .describe("Filter by status (active, completed, deprecated)"),
    },
    async ({ type, status }) => {
      const artifacts = listArtifacts(db, {
        type: type as ArtifactType | undefined,
        project,
        status,
      });
      return textResult({
        artifacts: artifacts.map((a) => ({
          traceId: a.traceId,
          type: a.type,
          title: a.title,
          status: a.status,
          links: a.links.length,
        })),
        count: artifacts.length,
      });
    },
  );

  // ── 5. gov_record — Record a new traced artifact ───────────────
  server.tool(
    "gov_record",
    "Record a new traced artifact (requirement, design decision, code change, test). Automatically generates a stable TraceId.",
    {
      type: z
        .enum(["REQ", "DES", "PLN", "CHG", "TST", "ADR"])
        .describe("Artifact type"),
      title: z.string().describe("Human-readable title"),
      description: z.string().describe("Full description"),
      implementsId: z
        .string()
        .optional()
        .describe("TraceId this artifact implements (creates a trace link)"),
      testsId: z.string().optional().describe("TraceId this artifact tests"),
      filePath: z.string().optional().describe("File path if applicable"),
    },
    async ({ type, title, description, implementsId, testsId, filePath }) => {
      const traceId = generateTraceId(
        type as ArtifactType,
        project,
        title + description,
      );
      const now = new Date().toISOString();

      const links = [];
      if (implementsId)
        links.push({ targetId: implementsId, relation: "implements" as const });
      if (testsId)
        links.push({ targetId: testsId, relation: "tests" as const });

      const artifact: TracedArtifact = {
        traceId,
        type: type as ArtifactType,
        project,
        title,
        description,
        status: "active",
        links,
        author: "agent",
        createdAt: now,
        updatedAt: now,
        filePath,
        metadata: {},
      };

      saveArtifact(db, artifact);
      return textResult({ traceId, type, title, links: links.length });
    },
  );

  // ── 6. gov_analytics — Engineering analytics report ────────────
  server.tool(
    "gov_analytics",
    "Generate engineering analytics report — model effectiveness, cost breakdown, tool usage, session metrics.",
    {
      daysBack: z
        .number()
        .optional()
        .describe("Days of history to analyze (default 30)"),
      format: z
        .enum(["json", "markdown"])
        .optional()
        .describe("Output format (default json)"),
    },
    async ({ daysBack, format }) => {
      const report = generateAnalyticsReport(db, { daysBack: daysBack ?? 30 });
      if (format === "markdown") {
        return {
          content: [
            { type: "text" as const, text: formatAnalyticsMarkdown(report) },
          ],
        };
      }
      return textResult(report);
    },
  );

  return 6;
}
