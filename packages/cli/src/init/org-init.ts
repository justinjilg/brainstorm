/**
 * Org Init Flow — onboards an organization's private GitHub repo.
 *
 * Sequence:
 * 1. Detect or prompt for GitHub repo URL
 * 2. Prompt for auth method (PAT or GitHub App)
 * 3. Store credentials in vault
 * 4. Clone/pull the repo (if remote)
 * 5. Run the full onboard pipeline (static analysis → code graph → sectors)
 * 6. Generate work plan (WORK-PLAN.md)
 * 7. Register webhook for auto-reindex on push
 * 8. Generate org-level brainstorm.toml with team defaults
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("org-init");

export interface OrgInitOptions {
  projectDir: string;
  yes?: boolean;
  force?: boolean;
}

export interface OrgInitResult {
  repoUrl: string;
  authMethod: string;
  filesIndexed: number;
  sectorsDetected: number;
  workPlanPath: string;
  webhookRegistered: boolean;
}

/**
 * Run the org initialization flow.
 */
export async function runOrgInit(opts: OrgInitOptions): Promise<OrgInitResult> {
  const { projectDir } = opts;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n  🏢 Brainstorm Org Initialization\n");

  // ── Step 1: Detect GitHub repo ──────────────────────────────────

  let repoUrl = detectGitRemote(projectDir);
  if (!repoUrl) {
    repoUrl = await rl.question(
      "  GitHub repo URL (e.g., github.com/org/repo): ",
    );
  } else {
    console.log(`  Detected repo: ${repoUrl}`);
  }

  const { owner, repo } = parseRepoUrl(repoUrl);
  console.log(`  Owner: ${owner}, Repo: ${repo}\n`);

  // ── Step 2: Auth method ─────────────────────────────────────────

  let authMethod = "pat";
  if (!opts.yes) {
    const answer = await rl.question(
      "  Auth method [pat/app] (default: pat): ",
    );
    if (answer.toLowerCase() === "app") authMethod = "app";
  }

  let token: string | undefined;
  if (authMethod === "pat") {
    token = process.env.GITHUB_TOKEN;
    if (!token) {
      token = await rl.question("  GitHub PAT: ");
    } else {
      console.log("  Using GITHUB_TOKEN from environment");
    }
  }

  rl.close();

  // ── Step 3: Store credentials ───────────────────────────────────

  // Store in environment for this session
  if (token) {
    process.env.GITHUB_TOKEN = token;
  }
  console.log("  ✓ Credentials configured\n");

  // ── Step 4: Index the codebase ──────────────────────────────────

  console.log("  📊 Indexing codebase...");
  const {
    CodeGraph,
    initializeAdapters,
    executePipeline,
    createDefaultPipeline,
    generateWorkPlan,
  } = await import("@brainst0rm/code-graph");

  const graph = new CodeGraph({ projectPath: projectDir });
  const langs = await initializeAdapters();
  console.log(`    Languages: ${langs.join(", ")}`);

  const result = await executePipeline(createDefaultPipeline(), {
    projectPath: projectDir,
    graph,
    results: new Map(),
    onProgress: (_stage, msg) => console.log(`    ${msg}`),
  });

  const stats = graph.extendedStats();
  console.log(
    `  ✓ Indexed: ${stats.files} files, ${stats.nodes} nodes, ${stats.graphEdges} edges, ${stats.communities} sectors\n`,
  );

  // ── Step 5: Generate work plan ──────────────────────────────────

  console.log("  📋 Generating work plan...");
  const plan = generateWorkPlan(graph, basename(projectDir));
  const workPlanPath = join(projectDir, "WORK-PLAN.md");
  writeFileSync(workPlanPath, plan.markdown, "utf-8");
  console.log(
    `  ✓ Work plan: ${plan.workItems.length} items across ${plan.sectors.length} sectors`,
  );
  console.log(
    `    Budget estimate: $${plan.orchestration.budgetEstimate.toFixed(2)}`,
  );
  console.log(`    Written to: ${workPlanPath}\n`);

  // ── Step 6: Generate org config ─────────────────────────────────

  const configPath = join(projectDir, "brainstorm.toml");
  if (!existsSync(configPath) || opts.force) {
    const config = generateOrgConfig(owner, repo, plan);
    writeFileSync(configPath, config, "utf-8");
    console.log("  ✓ Generated brainstorm.toml with team defaults\n");
  }

  // ── Step 7: Webhook registration ────────────────────────────────

  let webhookRegistered = false;
  const serverUrl = process.env.BRAINSTORM_SERVER_URL;
  if (serverUrl && token) {
    try {
      const { createGitHubConnector } = await import("@brainst0rm/godmode");
      const connector = createGitHubConnector(owner, repo);
      if (connector) {
        const client = connector.getClient();
        const webhookSecret = generateWebhookSecret();
        await client.createWebhook(
          owner,
          repo,
          `${serverUrl}/api/v1/webhooks/github`,
          webhookSecret,
        );
        webhookRegistered = true;
        console.log(
          `  ✓ Webhook registered: ${serverUrl}/api/v1/webhooks/github\n`,
        );
      }
    } catch (err: any) {
      console.log(`  ⚠ Webhook registration skipped: ${err.message}`);
      console.log(
        "    Set BRAINSTORM_SERVER_URL to enable auto-reindex on push\n",
      );
    }
  } else {
    console.log(
      "  ⚠ Webhook not registered (set BRAINSTORM_SERVER_URL to enable)",
    );
    console.log(
      "    The code graph will reindex manually via brainstorm analyze\n",
    );
  }

  // ── Step 8: GitHub Actions workflow ──────────────────────────────

  const workflowDir = join(projectDir, ".github", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  const workflowPath = join(workflowDir, "brainstorm-review.yml");
  if (!existsSync(workflowPath) || opts.force) {
    const { generateBrainstormReviewWorkflow } = await import("./templates.js");
    writeFileSync(workflowPath, generateBrainstormReviewWorkflow(), "utf-8");
    console.log("  ✓ GitHub Actions: .github/workflows/brainstorm-review.yml");
    console.log("    PRs get automated review with blast radius analysis\n");
  }

  // ── Summary ─────────────────────────────────────────────────────

  console.log("  ──────────────────────────────────────────────");
  console.log(`  🏢 ${owner}/${repo} is ready for Brainstorm`);
  console.log("");
  console.log("  Next steps:");
  console.log("  1. Review WORK-PLAN.md for the execution plan");
  console.log("  2. Share brainstorm.toml with your team");
  console.log(
    "  3. Each engineer: npm install -g @brainst0rm/cli && brainstorm chat",
  );
  console.log("  4. Start the daemon: brainstorm daemon --sectors");
  console.log("  ──────────────────────────────────────────────\n");

  graph.close();

  return {
    repoUrl,
    authMethod,
    filesIndexed: stats.files,
    sectorsDetected: stats.communities,
    workPlanPath,
    webhookRegistered,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function detectGitRemote(projectDir: string): string | null {
  try {
    const gitConfig = readFileSync(join(projectDir, ".git", "config"), "utf-8");
    const match = gitConfig.match(/url\s*=\s*(.+github\.com.+)/);
    if (match) return match[1].trim();
  } catch {}
  return null;
}

function parseRepoUrl(url: string): { owner: string; repo: string } {
  // Handle: github.com/org/repo, https://github.com/org/repo.git, git@github.com:org/repo.git
  const cleaned = url
    .replace(/^(https?:\/\/)?/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/^github\.com\//, "");
  const parts = cleaned.split("/");
  return { owner: parts[0] ?? "unknown", repo: parts[1] ?? "unknown" };
}

function generateWebhookSecret(): string {
  const { randomBytes } = require("node:crypto");
  return randomBytes(32).toString("hex");
}

function generateOrgConfig(owner: string, repo: string, plan: any): string {
  const criticalSectors = plan.sectors.filter(
    (s: any) => s.tier === "critical",
  ).length;
  const totalSectors = plan.sectors.length;

  return [
    `# Brainstorm Org Configuration — ${owner}/${repo}`,
    `# Generated by brainstorm init --org`,
    "",
    "[general]",
    `defaultStrategy = "capability"`,
    `defaultPermissionMode = "auto"`,
    `outputStyle = "concise"`,
    "",
    "[budget]",
    `daily = 25.0`,
    `monthly = 500.0`,
    `perSession = 5.0`,
    `hardLimit = true`,
    "",
    "[daemon]",
    `tickIntervalMs = 60000`,
    `maxTicksPerSession = 500`,
    `sectorMode = true`,
    "",
    `[github]`,
    `owner = "${owner}"`,
    `repo = "${repo}"`,
    `autoReindex = true`,
    "",
    `# ${totalSectors} sectors detected (${criticalSectors} critical)`,
    `# Model routing handled by BrainstormRouter QualityTier system`,
    `# Critical sectors → QualityTier 1, Simple → QualityTier 5`,
  ].join("\n");
}
