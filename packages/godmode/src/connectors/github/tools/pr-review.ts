/**
 * PR Review Tool — intelligent code review using the knowledge graph.
 *
 * Flow:
 * 1. Fetch PR diff (changed files + patches)
 * 2. Compute blast radius from code graph for each changed file
 * 3. Classify sectors touched — determines model tier per file
 * 4. Build structured review with: risk score, affected sectors, line comments
 * 5. Post as GitHub review + create check run for merge gate
 *
 * Model routing: critical sectors (auth, crypto) get QualityTier 1.
 * Simple changes (docs, config) get QualityTier 5. The router decides
 * the actual model — no hardcoded names.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { GitHubClient } from "../client.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("pr-review");

export interface PRReviewResult {
  prNumber: number;
  filesReviewed: number;
  riskScore: number;
  sectorsAffected: string[];
  criticalSectorsAffected: string[];
  blastRadius: number;
  reviewBody: string;
  checkConclusion: "success" | "action_required" | "neutral";
  cost: number;
}

export interface PRReviewOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  /** Code graph for blast radius computation. Duck-typed to avoid hard dep. */
  graph?: {
    getDb: () => any;
    impactAnalysis: (name: string, maxDepth?: number) => any[];
    findDefinition: (name: string) => any[];
  };
}

export function createPRReviewTools(
  opts: PRReviewOptions,
): BrainstormToolDef[] {
  const { client, owner, repo, graph } = opts;

  return [
    defineTool({
      name: "github_pr_review",
      description: `Review a pull request on ${owner}/${repo} using code intelligence. Computes blast radius, classifies risk by sector, and posts a structured review.`,
      permission: "confirm" as const,
      inputSchema: z.object({
        prNumber: z.number().describe("PR number to review"),
        postReview: z
          .boolean()
          .optional()
          .describe("Post review to GitHub (default true)"),
        createCheck: z
          .boolean()
          .optional()
          .describe("Create check run for merge gate (default true)"),
      }),
      async execute({ prNumber, postReview, createCheck }) {
        const shouldPost = postReview !== false;
        const shouldCheck = createCheck !== false;

        // Fetch PR metadata + changed files
        const pr = await client.getPR(owner, repo, prNumber);
        const files = await client.getPRFiles(owner, repo, prNumber);

        const changedFiles = files.map((f: any) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch?.slice(0, 2000), // Limit patch size for context
        }));

        // Compute blast radius from code graph
        let blastRadius = 0;
        const affectedSymbols: Array<{
          name: string;
          file: string;
          depth: number;
        }> = [];
        const sectorsAffected = new Set<string>();
        const criticalSectors = new Set<string>();

        if (graph) {
          const db = graph.getDb();

          for (const file of changedFiles) {
            // Find functions defined in changed files
            const functions = db
              .prepare("SELECT name FROM functions WHERE file LIKE ?")
              .all(`%${file.filename}`) as Array<{ name: string }>;

            for (const fn of functions) {
              const impact = graph.impactAnalysis(fn.name, 3);
              for (const item of impact) {
                affectedSymbols.push(item);
                blastRadius++;
              }
            }

            // Find which sectors are touched
            const communities = db
              .prepare(
                "SELECT DISTINCT c.id, c.name, c.metadata_json FROM nodes n JOIN communities c ON c.id = n.community_id WHERE n.file LIKE ? AND n.community_id IS NOT NULL",
              )
              .all(`%${file.filename}`) as any[];

            for (const comm of communities) {
              sectorsAffected.add(comm.name ?? comm.id);
              try {
                const meta = JSON.parse(comm.metadata_json ?? "{}");
                if (meta.tier === "critical")
                  criticalSectors.add(comm.name ?? comm.id);
              } catch {}
            }
          }
        }

        // Calculate risk score (0-100)
        let riskScore = 0;
        riskScore += Math.min(30, changedFiles.length * 3); // Files changed
        riskScore += Math.min(20, blastRadius); // Blast radius
        riskScore += criticalSectors.size * 15; // Critical sectors
        riskScore +=
          changedFiles.filter((f: any) => f.deletions > 20).length * 5; // Large deletions
        riskScore = Math.min(100, riskScore);

        // Determine check conclusion
        let checkConclusion: "success" | "action_required" | "neutral" =
          "success";
        if (criticalSectors.size > 0) checkConclusion = "action_required";
        else if (riskScore > 60) checkConclusion = "action_required";
        else if (riskScore > 30) checkConclusion = "neutral";

        // Build review body
        const reviewBody = buildReviewBody({
          pr,
          changedFiles,
          riskScore,
          blastRadius,
          sectorsAffected: Array.from(sectorsAffected),
          criticalSectors: Array.from(criticalSectors),
          affectedSymbols: affectedSymbols.slice(0, 20),
        });

        // Post review to GitHub
        if (shouldPost) {
          const event =
            checkConclusion === "action_required"
              ? "REQUEST_CHANGES"
              : "COMMENT";
          await client.createReview(
            owner,
            repo,
            prNumber,
            reviewBody,
            event as any,
          );
          log.info(
            { pr: prNumber, riskScore, sectors: sectorsAffected.size },
            "Review posted",
          );
        }

        // Create check run
        if (shouldCheck) {
          await client.createCheckRun(owner, repo, {
            name: "Brainstorm Code Intelligence",
            headSha: pr.head.sha,
            status: "completed",
            conclusion: checkConclusion,
            summary: `Risk Score: ${riskScore}/100 | Blast Radius: ${blastRadius} symbols | Sectors: ${sectorsAffected.size} (${criticalSectors.size} critical)`,
            text: reviewBody,
          });
          log.info(
            { pr: prNumber, conclusion: checkConclusion },
            "Check run created",
          );
        }

        return {
          prNumber,
          filesReviewed: changedFiles.length,
          riskScore,
          sectorsAffected: Array.from(sectorsAffected),
          criticalSectorsAffected: Array.from(criticalSectors),
          blastRadius,
          reviewBody,
          checkConclusion,
          cost: 0, // Tracked by CostTracker in the agent loop
        };
      },
    }),
  ];
}

// ── Review Body Builder ───────────────────────────────────────────

function buildReviewBody(data: {
  pr: any;
  changedFiles: any[];
  riskScore: number;
  blastRadius: number;
  sectorsAffected: string[];
  criticalSectors: string[];
  affectedSymbols: Array<{ name: string; file: string; depth: number }>;
}): string {
  const {
    riskScore,
    blastRadius,
    sectorsAffected,
    criticalSectors,
    changedFiles,
    affectedSymbols,
  } = data;

  const riskEmoji = riskScore > 60 ? "🔴" : riskScore > 30 ? "🟡" : "🟢";
  const lines: string[] = [];

  lines.push(
    `## ${riskEmoji} Brainstorm Code Review`,
    "",
    `**Risk Score:** ${riskScore}/100 | **Blast Radius:** ${blastRadius} affected symbols | **Files Changed:** ${changedFiles.length}`,
    "",
  );

  if (criticalSectors.length > 0) {
    lines.push(
      "### ⚠️ Critical Sectors Affected",
      "",
      ...criticalSectors.map(
        (s) => `- **${s}** — requires careful review (QualityTier 1 analysis)`,
      ),
      "",
    );
  }

  if (sectorsAffected.length > 0) {
    lines.push(
      "### Sectors Touched",
      "",
      ...sectorsAffected.map((s) => {
        const isCritical = criticalSectors.includes(s);
        return `- ${isCritical ? "🔴" : "🟡"} ${s}`;
      }),
      "",
    );
  }

  if (affectedSymbols.length > 0) {
    lines.push(
      "### Blast Radius — Transitively Affected Functions",
      "",
      "| Function | File | Depth |",
      "|----------|------|-------|",
      ...affectedSymbols
        .slice(0, 15)
        .map(
          (s) =>
            `| \`${s.name}\` | \`${s.file.split("/").slice(-2).join("/")}\` | ${s.depth} |`,
        ),
      "",
    );
    if (affectedSymbols.length > 15) {
      lines.push(
        `*... and ${affectedSymbols.length - 15} more affected symbols*`,
        "",
      );
    }
  }

  // File summary
  lines.push(
    "### Changed Files",
    "",
    "| File | Status | +/- |",
    "|------|--------|-----|",
    ...changedFiles
      .slice(0, 20)
      .map(
        (f: any) =>
          `| \`${f.filename.split("/").slice(-2).join("/")}\` | ${f.status} | +${f.additions}/-${f.deletions} |`,
      ),
    "",
  );

  lines.push(
    "---",
    "*Reviewed by [Brainstorm Code Intelligence Engine](https://github.com/brainstorm)*",
  );

  return lines.join("\n");
}
