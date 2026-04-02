/**
 * Phase 4: Workflow Generation — create project-specific recipes.
 *
 * Two-step:
 * 1. Heuristic recipe detection from analysis (free)
 * 2. LLM customization of step descriptions
 *
 * Output: YAML recipe files in .brainstorm/recipes/
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import type {
  OnboardContext,
  OnboardDispatcher,
  GeneratedRecipe,
} from "../types.js";
import { buildWorkflowPrompt } from "../prompts/workflow.js";

interface PhaseResult {
  contextPatch: Partial<OnboardContext>;
  cost: number;
  summary: string;
  filesWritten?: string[];
}

export async function runWorkflowGen(
  context: OnboardContext,
  dispatcher: OnboardDispatcher,
): Promise<PhaseResult> {
  const { analysis, exploration } = context;

  // Step 1: Heuristic recipe generation (free)
  const heuristicRecipes = generateHeuristicRecipes(analysis);

  if (heuristicRecipes.length === 0) {
    return {
      contextPatch: { recipes: [] },
      cost: 0,
      summary: "No recipes generated (project too simple)",
    };
  }

  // Step 2: LLM customization
  const prompt = buildWorkflowPrompt(analysis, exploration, heuristicRecipes);
  const response = await dispatcher.generate(prompt, 0.1);

  let recipes: GeneratedRecipe[];
  try {
    let json = response.text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    recipes = JSON.parse(json);
  } catch {
    // Fall back to heuristic recipes
    recipes = heuristicRecipes;
  }

  // Write recipe files
  const recipesDir = join(analysis.projectPath, ".brainstorm", "recipes");
  if (!existsSync(recipesDir)) mkdirSync(recipesDir, { recursive: true });

  const filesWritten: string[] = [];
  for (const recipe of recipes) {
    const recipePath = join(recipesDir, recipe.filename);
    writeFileSync(recipePath, recipe.content, "utf-8");
    filesWritten.push(recipePath);
  }

  const recipeNames = recipes
    .map((r) => r.filename.replace(".yaml", ""))
    .join(", ");

  return {
    contextPatch: { recipes },
    cost: response.cost,
    summary: `${recipes.length} recipes: ${recipeNames}`,
    filesWritten,
  };
}

/**
 * Generate heuristic recipes based on detected project patterns.
 */
function generateHeuristicRecipes(
  analysis: ProjectAnalysis,
): GeneratedRecipe[] {
  const recipes: GeneratedRecipe[] = [];
  const frameworks = analysis.frameworks.frameworks.map((f) => f.toLowerCase());
  const hasTests = analysis.frameworks.testing.length > 0;
  const hasCI = analysis.frameworks.ci && analysis.frameworks.ci.length > 0;
  const isMonorepo =
    frameworks.includes("turborepo") || frameworks.includes("lerna");

  // PR-ready recipe: implement → test → review
  if (hasTests) {
    const testTool = analysis.frameworks.testing[0] ?? "test runner";
    recipes.push({
      filename: "pr-ready.yaml",
      content: buildPrReadyRecipe(analysis, testTool),
      description: "Full PR workflow: plan → implement → test → review",
    });
  }

  // Multi-package change recipe for monorepos
  if (isMonorepo) {
    recipes.push({
      filename: "multi-package-change.yaml",
      content: buildMultiPackageRecipe(analysis),
      description: "Coordinate changes across multiple packages",
    });
  }

  // Deploy flow recipe
  if (hasCI) {
    recipes.push({
      filename: "deploy-flow.yaml",
      content: buildDeployRecipe(analysis),
      description: "Implement → verify → deploy pipeline",
    });
  }

  return recipes;
}

function buildPrReadyRecipe(
  analysis: ProjectAnalysis,
  testTool: string,
): string {
  const buildCmd = inferBuildCmd(analysis);
  const testCmd = inferTestCmd(analysis, testTool);

  return `name: PR Ready
description: Full workflow from plan to review-ready PR
communication: handoff
maxIterations: 2
steps:
  - id: plan
    role: architect
    description: "Analyze the task and create an implementation plan with file changes needed"
    output: spec
    outputSchema: implementation-spec

  - id: implement
    role: coder
    description: "Implement the changes according to the plan"
    input: [spec]
    output: code

  - id: test
    role: qa
    description: "Run ${testTool} tests and verify the changes work correctly (${testCmd})"
    input: [spec, code]
    output: test-result

  - id: review
    role: code-reviewer
    description: "Review for correctness, conventions, and potential issues"
    input: [spec, code, test-result]
    output: review
    review: true
    loopBack: implement
`;
}

function buildMultiPackageRecipe(analysis: ProjectAnalysis): string {
  return `name: Multi-Package Change
description: Coordinate changes across multiple monorepo packages
communication: handoff
maxIterations: 2
steps:
  - id: plan
    role: architect
    description: "Map which packages need changes and their dependency order"
    output: spec
    outputSchema: implementation-spec

  - id: implement
    role: coder
    description: "Implement changes in dependency order — leaf packages first, dependents after"
    input: [spec]
    output: code

  - id: verify
    role: qa
    description: "Run full monorepo build (npx turbo run build) and tests to verify cross-package compatibility"
    input: [spec, code]
    output: test-result

  - id: review
    role: code-reviewer
    description: "Review for cross-package consistency and interface contracts"
    input: [spec, code, test-result]
    output: review
    review: true
    loopBack: implement
`;
}

function buildDeployRecipe(analysis: ProjectAnalysis): string {
  return `name: Deploy Flow
description: Implement, verify, and prepare for deployment
communication: handoff
maxIterations: 2
steps:
  - id: implement
    role: coder
    description: "Implement the changes"
    output: code

  - id: verify
    role: qa
    description: "Run build and tests to verify deployment readiness"
    input: [code]
    output: test-result

  - id: deploy-prep
    role: devops
    description: "Review deployment configuration and prepare deployment steps"
    input: [code, test-result]
    output: deploy-plan

  - id: review
    role: code-reviewer
    description: "Final review before deployment"
    input: [code, test-result, deploy-plan]
    output: review
    review: true
    loopBack: implement
`;
}

function inferBuildCmd(analysis: ProjectAnalysis): string {
  const frameworks = analysis.frameworks.frameworks.map((f) => f.toLowerCase());
  if (frameworks.includes("turborepo")) return "npx turbo run build";
  return "npm run build";
}

function inferTestCmd(analysis: ProjectAnalysis, testTool: string): string {
  const lower = testTool.toLowerCase();
  if (lower.includes("vitest")) return "npx vitest run";
  if (lower.includes("jest")) return "npx jest";
  if (lower.includes("pytest")) return "pytest";
  return "npm test";
}
