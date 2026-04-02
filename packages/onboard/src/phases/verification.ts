/**
 * Phase 6: Verification — validates all generated artifacts.
 *
 * Pure deterministic validation — no LLM calls, zero cost.
 * Parses .agent.md files, BRAINSTORM.md frontmatter, recipe YAMLs,
 * and routing rules to catch generation errors before the user
 * starts working with a broken setup.
 */

import { existsSync, readFileSync } from "node:fs";
import type { OnboardContext, VerificationResult } from "../types.js";

/**
 * Validate all generated artifacts in the onboard context.
 */
export function runVerification(context: OnboardContext): VerificationResult {
  const result: VerificationResult = {
    agentsValid: true,
    agentErrors: [],
    routingValid: true,
    routingErrors: [],
    recipesValid: true,
    recipeErrors: [],
    brainstormMdValid: true,
    brainstormMdErrors: [],
  };

  // Validate agents
  if (context.agents) {
    for (const agent of context.agents) {
      const errors = validateAgentContent(agent.id, agent.content);
      if (errors.length > 0) {
        result.agentsValid = false;
        result.agentErrors.push(...errors);
      }
    }
  }

  // Validate routing rules
  if (context.routingRules) {
    for (const rule of context.routingRules) {
      if (!rule.match || !rule.agentId) {
        result.routingValid = false;
        result.routingErrors.push(
          `Rule missing required fields: match="${rule.match}", agentId="${rule.agentId}"`,
        );
      }
      // Check that agentId references a generated agent
      if (
        context.agents &&
        !context.agents.some((a) => a.id === rule.agentId)
      ) {
        result.routingValid = false;
        result.routingErrors.push(
          `Rule references unknown agent "${rule.agentId}"`,
        );
      }
    }
  }

  // Validate recipes
  if (context.recipes) {
    for (const recipe of context.recipes) {
      const errors = validateRecipeContent(recipe.filename, recipe.content);
      if (errors.length > 0) {
        result.recipesValid = false;
        result.recipeErrors.push(...errors);
      }
    }
  }

  // Validate BRAINSTORM.md
  if (context.brainstormMd) {
    const errors = validateBrainstormMd(context.brainstormMd);
    if (errors.length > 0) {
      result.brainstormMdValid = false;
      result.brainstormMdErrors.push(...errors);
    }
  }

  return result;
}

/**
 * Validate .agent.md content has valid frontmatter structure.
 */
function validateAgentContent(id: string, content: string): string[] {
  const errors: string[] = [];

  // Must have frontmatter delimiters
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    errors.push(`Agent "${id}": missing YAML frontmatter (---)`);
    return errors;
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  // Must have a name field
  if (!/^name:\s*.+$/m.test(frontmatter)) {
    errors.push(`Agent "${id}": missing "name" field in frontmatter`);
  }

  // Must have a role field
  if (!/^role:\s*.+$/m.test(frontmatter)) {
    errors.push(`Agent "${id}": missing "role" field in frontmatter`);
  }

  // Should have a system prompt body
  if (!body) {
    errors.push(`Agent "${id}": empty system prompt body`);
  }

  return errors;
}

/**
 * Validate recipe YAML has required fields.
 */
function validateRecipeContent(filename: string, content: string): string[] {
  const errors: string[] = [];

  // Basic YAML structure checks (we don't pull in a YAML parser for verification)
  if (!content.includes("name:")) {
    errors.push(`Recipe "${filename}": missing "name" field`);
  }
  if (!content.includes("steps:")) {
    errors.push(`Recipe "${filename}": missing "steps" field`);
  }

  return errors;
}

/**
 * Validate BRAINSTORM.md has frontmatter with version field.
 */
function validateBrainstormMd(content: string): string[] {
  const errors: string[] = [];

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    // Body-only is acceptable — frontmatter is optional
    return errors;
  }

  const frontmatter = fmMatch[1];
  if (!/version:\s*1/.test(frontmatter)) {
    errors.push("BRAINSTORM.md: frontmatter missing version: 1");
  }

  return errors;
}
