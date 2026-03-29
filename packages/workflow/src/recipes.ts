/**
 * Recipe System — shareable YAML workflow definitions.
 *
 * Recipes live in `.brainstorm/recipes/` (project-level) or
 * `~/.brainstorm/recipes/` (global). Each is a YAML file that
 * maps to a WorkflowDefinition.
 *
 * Flywheel: shared recipes = same workflow across users →
 * BrainstormLLM sees repeated patterns → learns optimal phase config.
 *
 * Format:
 * ```yaml
 * name: Implement Feature
 * description: Plan → code → review loop
 * communication: handoff
 * maxIterations: 3
 * steps:
 *   - id: plan
 *     role: architect
 *     description: Create implementation plan
 *     output: spec
 *     outputSchema: implementation-spec
 *   - id: code
 *     role: coder
 *     description: Implement the code
 *     input: [spec]
 *     output: code
 *   - id: review
 *     role: reviewer
 *     description: Review for correctness
 *     input: [spec, code]
 *     output: review
 *     review: true
 *     loopBack: code
 * ```
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYAML } from "yaml";
import type {
  WorkflowDefinition,
  WorkflowStepDef,
  AgentRole,
  CommunicationMode,
} from "@brainst0rm/shared";

export interface RecipeFile {
  name: string;
  description: string;
  communication?: CommunicationMode;
  maxIterations?: number;
  steps: RecipeStep[];
}

interface RecipeStep {
  id: string;
  role: string;
  description: string;
  input?: string[];
  output: string;
  outputSchema?: string;
  review?: boolean;
  loopBack?: string;
  skip?: string;
}

/**
 * Load all recipes from project-level and global recipe directories.
 * Project recipes override global ones with the same filename.
 */
export function loadRecipes(projectPath: string): WorkflowDefinition[] {
  const globalDir = join(homedir(), ".brainstorm", "recipes");
  const projectDir = join(projectPath, ".brainstorm", "recipes");

  const globalRecipes = loadRecipesFromDir(globalDir);
  const projectRecipes = loadRecipesFromDir(projectDir);

  // Project recipes override global ones by id
  const merged = new Map<string, WorkflowDefinition>();
  for (const r of globalRecipes) merged.set(r.id, r);
  for (const r of projectRecipes) merged.set(r.id, r);

  return [...merged.values()];
}

/**
 * Load a single recipe by name (filename without extension).
 */
export function loadRecipe(
  projectPath: string,
  name: string,
): WorkflowDefinition | null {
  const projectFile = join(
    projectPath,
    ".brainstorm",
    "recipes",
    `${name}.yaml`,
  );
  const globalFile = join(homedir(), ".brainstorm", "recipes", `${name}.yaml`);

  // Project-level takes precedence
  const file = existsSync(projectFile)
    ? projectFile
    : existsSync(globalFile)
      ? globalFile
      : null;

  if (!file) return null;

  try {
    const content = readFileSync(file, "utf-8");
    return parseRecipeYAML(name, content);
  } catch {
    return null;
  }
}

/**
 * Initialize the recipe directory with example recipes.
 */
export function initRecipeDir(projectPath: string): string {
  const dir = join(projectPath, ".brainstorm", "recipes");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write example recipe if directory is empty
  const files = readdirSync(dir).filter(
    (f) => extname(f) === ".yaml" || extname(f) === ".yml",
  );
  if (files.length === 0) {
    const example = `# Example recipe — customize or create new ones
name: Quick Review
description: Fast code review with a quality model
communication: handoff
maxIterations: 1
steps:
  - id: review
    role: reviewer
    description: Review code for bugs, security, and style issues
    output: review
    outputSchema: review-result
`;
    const examplePath = join(dir, "quick-review.yaml");
    writeFileSync(examplePath, example, "utf-8");
  }

  return dir;
}

/**
 * List available recipes (names + descriptions).
 */
export function listRecipes(
  projectPath: string,
): Array<{ id: string; name: string; description: string; source: string }> {
  const globalDir = join(homedir(), ".brainstorm", "recipes");
  const projectDir = join(projectPath, ".brainstorm", "recipes");

  const results: Array<{
    id: string;
    name: string;
    description: string;
    source: string;
  }> = [];
  const seen = new Set<string>();

  // Project recipes first (they override global)
  for (const recipe of loadRecipesFromDir(projectDir)) {
    results.push({
      id: recipe.id,
      name: recipe.name,
      description: recipe.description,
      source: "project",
    });
    seen.add(recipe.id);
  }

  for (const recipe of loadRecipesFromDir(globalDir)) {
    if (!seen.has(recipe.id)) {
      results.push({
        id: recipe.id,
        name: recipe.name,
        description: recipe.description,
        source: "global",
      });
    }
  }

  return results;
}

// ── Internal ──────────────────────────────────────────────────────────

function loadRecipesFromDir(dir: string): WorkflowDefinition[] {
  if (!existsSync(dir)) return [];

  const recipes: WorkflowDefinition[] = [];
  const files = readdirSync(dir).filter(
    (f) => extname(f) === ".yaml" || extname(f) === ".yml",
  );

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const id = basename(file, extname(file));
      recipes.push(parseRecipeYAML(id, content));
    } catch {
      // Skip malformed recipes
    }
  }

  return recipes;
}

function parseRecipeYAML(id: string, content: string): WorkflowDefinition {
  const raw = parseYAML(content) as RecipeFile;

  if (!raw.name || !raw.steps || !Array.isArray(raw.steps)) {
    throw new Error(`Invalid recipe: missing name or steps`);
  }

  const steps: WorkflowStepDef[] = raw.steps.map((s) => ({
    id: s.id,
    agentRole: (s.role ?? "coder") as AgentRole,
    description: s.description ?? "",
    inputArtifacts: s.input ?? [],
    outputArtifact: s.output,
    outputSchema: s.outputSchema,
    isReviewStep: s.review ?? false,
    loopBackTo: s.loopBack,
    skipCondition: s.skip,
  }));

  return {
    id,
    name: raw.name,
    description: raw.description ?? "",
    steps,
    communicationMode: raw.communication ?? "handoff",
    maxIterations: raw.maxIterations ?? 2,
  };
}
