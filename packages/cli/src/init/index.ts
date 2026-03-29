import { detectProject } from "./detect.js";
import { runPrompts, buildDefaultChoices } from "./prompts.js";
import {
  generateFile,
  mergeGitignore,
  type GenerateResult,
} from "./generate.js";
import {
  generateStormMd,
  generateBrainstormToml,
  generateGitignore,
  generateBrainstormignore,
  generatePrettierrc,
  generateEnvExample,
  generateCiWorkflow,
  generateDeployWorkflow,
  generateReleaseWorkflow,
  generateDependabot,
  generatePrTemplate,
  generateBugTemplate,
  generateFeatureTemplate,
  type InitChoices,
  type GatewayInfo,
} from "./templates.js";
import { createGatewayClient } from "@brainst0rm/gateway";

export interface InitOptions {
  yes?: boolean;
  force?: boolean;
}

/**
 * Orchestrate the init flow: detect → gateway probe → prompt → generate → report.
 */
export async function runInit(
  projectDir: string,
  options: InitOptions,
): Promise<void> {
  // Phase 1: Detect
  const detection = await detectProject(projectDir);

  // Phase 1.5: Probe BrainstormRouter gateway if API key is set
  let gatewayInfo: GatewayInfo | null = null;
  const gw = createGatewayClient();
  if (gw) {
    try {
      const [self, health, discovery] = await Promise.all([
        gw.getSelf().catch(() => null),
        gw.getHealth().catch(() => ({ status: "unknown" })),
        gw.getDiscovery().catch(() => null),
      ]);
      if (self) {
        gatewayInfo = {
          connected: true,
          modelCount: discovery?.models?.available ?? 0,
          budget: discovery?.budget
            ? `$${discovery.budget.remaining_usd?.toFixed(2)}/${discovery.budget.period}`
            : undefined,
          health: health.status,
        };
      }
    } catch {
      // Gateway not reachable — proceed without it
    }
  }

  // Phase 2: Get choices (interactive or defaults)
  let choices: InitChoices | null;
  if (options.yes) {
    choices = buildDefaultChoices(detection);
    // Auto-set cloud provider when gateway is detected
    if (gatewayInfo) choices.cloudProvider = "brainstormrouter";
    console.log("\n  brainstorm init --yes\n");
    console.log(`  Auto-detected: ${choices.language} ${choices.type}`);
    if (detection.localModels.length > 0) {
      console.log(`  Local models: ${detection.localModels.join(", ")}`);
    }
    if (gatewayInfo) {
      console.log(
        `  Gateway: connected (${gatewayInfo.modelCount} models, ${gatewayInfo.health})`,
      );
      if (gatewayInfo.budget) console.log(`  Budget: ${gatewayInfo.budget}`);
    }
    console.log();
  } else {
    // Show gateway detection before prompts
    if (gatewayInfo) {
      console.log(
        `\n  BrainstormRouter detected: ${gatewayInfo.modelCount} models, ${gatewayInfo.health}`,
      );
    }
    choices = await runPrompts(detection);
    if (!choices) return; // User aborted
    // Auto-set cloud provider when gateway is detected
    if (gatewayInfo) choices.cloudProvider = "brainstormrouter";
  }

  // Phase 3: Generate files
  const results: GenerateResult[] = [];
  const opts = { force: options.force };

  // Core files (always generated)
  results.push(
    generateFile(projectDir, "STORM.md", generateStormMd(choices), opts),
  );
  results.push(
    generateFile(
      projectDir,
      "brainstorm.toml",
      generateBrainstormToml(choices),
      opts,
    ),
  );
  results.push(
    generateFile(
      projectDir,
      ".brainstormignore",
      generateBrainstormignore(),
      opts,
    ),
  );
  results.push(
    generateFile(projectDir, ".env.example", generateEnvExample(choices), opts),
  );

  // .gitignore (merge mode)
  results.push(mergeGitignore(projectDir, generateGitignore(choices)));

  // Formatting
  results.push(
    generateFile(projectDir, ".prettierrc", generatePrettierrc(), opts),
  );

  // CI/CD
  if (choices.ciTier !== "none") {
    results.push(
      generateFile(
        projectDir,
        ".github/workflows/ci.yml",
        generateCiWorkflow(choices),
        opts,
      ),
    );
    results.push(
      generateFile(
        projectDir,
        ".github/pull_request_template.md",
        generatePrTemplate(),
        opts,
      ),
    );
    results.push(
      generateFile(
        projectDir,
        ".github/ISSUE_TEMPLATE/bug_report.md",
        generateBugTemplate(),
        opts,
      ),
    );
    results.push(
      generateFile(
        projectDir,
        ".github/ISSUE_TEMPLATE/feature_request.md",
        generateFeatureTemplate(),
        opts,
      ),
    );

    if (choices.ciTier === "full") {
      results.push(
        generateFile(
          projectDir,
          ".github/workflows/deploy.yml",
          generateDeployWorkflow(choices),
          opts,
        ),
      );
      results.push(
        generateFile(
          projectDir,
          ".github/workflows/release.yml",
          generateReleaseWorkflow(),
          opts,
        ),
      );
      results.push(
        generateFile(
          projectDir,
          ".github/dependabot.yml",
          generateDependabot(),
          opts,
        ),
      );
    }
  }

  // Phase 4: Report
  console.log("  Results:\n");
  for (const r of results) {
    const icon =
      r.action === "created" ? "+" : r.action === "merged" ? "~" : "-";
    const label =
      r.action === "created"
        ? "created"
        : r.action === "merged"
          ? "merged"
          : "exists (skipped)";
    console.log(`    ${icon} ${r.path}  (${label})`);
  }

  const created = results.filter((r) => r.action === "created").length;
  const merged = results.filter((r) => r.action === "merged").length;
  const skipped = results.filter((r) => r.action === "skipped").length;

  console.log(
    `\n  Done. ${created} created, ${merged} merged, ${skipped} skipped.`,
  );
  console.log(
    "  Edit STORM.md to add your architecture, entry points, and conventions.\n",
  );
}
