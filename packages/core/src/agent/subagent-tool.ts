import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import {
  spawnSubagent,
  spawnParallel,
  getSubagentTypeConfig,
  SUBAGENT_TYPE_NAMES,
  type SubagentOptions,
  type SubagentType,
} from "./subagent.js";

// Both the top-level and per-parallel-item type enums are derived from the
// single source of truth (SUBAGENT_TYPE_NAMES) so they can never drift apart —
// the parallel enum previously hardcoded a shorter list that omitted
// "research"/"memory-curator".
const TYPE_ENUM = z.enum(SUBAGENT_TYPE_NAMES as [string, ...string[]]);

/**
 * Intersect a model-supplied allowlist with a trusted options-level one.
 * The model's list can only narrow a trusted caller's narrowing — never
 * replace it (which would let model input widen back to the type ceiling).
 */
function intersectAllowlists(a?: string[], b?: string[]): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const set = new Set(b);
  return a.filter((t) => set.has(t));
}

/**
 * Create the subagent tool with runtime context injected.
 *
 * This tool lives in @brainst0rm/core (not @brainst0rm/tools) because it
 * depends on the subagent execution engine, which would create a circular
 * dependency if placed in the tools package.
 *
 * The model can call this tool to spawn focused subagents for parallel work:
 * - explore: fast codebase search (read-only, cheap model)
 * - plan: design implementation approach (read + task tools)
 * - code: implement changes (full tool access, capable model)
 * - review: review code for bugs (read + git tools)
 * - general: any focused task (all tools, cheap model)
 */
export function createSubagentTool(
  options: SubagentOptions,
): BrainstormToolDef {
  return defineTool({
    name: "subagent",
    description:
      "Spawn a focused subagent to handle a task in isolation. " +
      "Subagents get their own conversation context and return results when done. " +
      'Use "explore" for codebase search, "plan" for design, "code" for implementation, ' +
      '"review" for code review, or "general" for any focused task. ' +
      'Pass multiple items to the "parallel" array to run several subagents concurrently. ' +
      "Optionally narrow scope with toolAllowlist (a subset of the type's tools) and " +
      "add extra instructions with promptAppend (appended to, never replacing, the type's prompt).",
    permission: "auto",
    inputSchema: z.object({
      task: z
        .string()
        .optional()
        .describe(
          "Task prompt for a single subagent. Use this OR parallel, not both.",
        ),
      type: TYPE_ENUM.default("general").describe(
        "Subagent type — determines available tools, system prompt, and model selection.",
      ),
      toolAllowlist: z
        .array(z.string())
        .optional()
        .describe(
          "Narrows the subagent's tools to this subset; names outside the type's allowed set are ignored (scope can only be narrowed, never widened). In parallel mode, applies as the default for items without their own.",
        ),
      promptAppend: z
        .string()
        .optional()
        .describe(
          "Extra instructions appended to the type's system prompt (never replaces it). In parallel mode, applies as the default for items without their own.",
        ),
      maxSteps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Step budget; clamped to 2x the type's default. In parallel mode, applies as the default for items without their own.",
        ),
      budgetLimit: z
        .number()
        .positive()
        .optional()
        .describe(
          "Dollar budget; clamped to the configured subagent budget ceiling. In parallel mode, applies as the default for items without their own.",
        ),
      parallel: z
        .array(
          z.object({
            task: z.string().describe("Task prompt for this subagent."),
            type: TYPE_ENUM.default("general").describe(
              "Subagent type for this task.",
            ),
            toolAllowlist: z
              .array(z.string())
              .optional()
              .describe(
                "Narrows this subagent's tools to this subset; names outside the type's allowed set are ignored (scope can only be narrowed, never widened).",
              ),
            promptAppend: z
              .string()
              .optional()
              .describe(
                "Extra instructions appended to this type's system prompt (never replaces it).",
              ),
            maxSteps: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Step budget; clamped to 2x the type's default."),
            budgetLimit: z
              .number()
              .positive()
              .optional()
              .describe(
                "Dollar budget; clamped to the configured subagent budget ceiling.",
              ),
          }),
        )
        .optional()
        .describe(
          "Run multiple subagents in parallel. Each gets its own context.",
        ),
    }),
    execute: async (input, ctx) => {
      // Link the tool-call abortSignal (comes from the parent agent loop)
      // into the options we forward to spawnSubagent, so a parent Ctrl+C
      // or request-disconnect terminates spawned subagents too.
      const linkedOptions: SubagentOptions = {
        ...options,
        parentSignal: ctx?.abortSignal,
      };

      // Lazy parent ceiling: derive the privilege ceiling from the LIVE tool
      // registry at call time. Computing this at registration time would
      // exclude tools registered later in boot (e.g. godmode Phase E). Only
      // set it if the caller didn't already pin an explicit parent set.
      if (!linkedOptions.parentToolNames) {
        linkedOptions.parentToolNames = options.tools
          .listTools()
          .map((t) => t.name);
      }

      // Budget ceiling for model-supplied dollar limits.
      const budgetCeiling = options.costTracker.getSubagentBudget();

      // Parallel mode: multiple subagents at once
      if (input.parallel && input.parallel.length > 0) {
        const results = await spawnParallel(
          input.parallel.map((spec) => {
            const specType = spec.type as SubagentType;
            // Top-level input fields act as defaults for items that don't
            // set their own; a trusted options-level allowlist is intersected,
            // never replaced, by model input.
            const specAllowlist = spec.toolAllowlist ?? input.toolAllowlist;
            const specMaxSteps = spec.maxSteps ?? input.maxSteps;
            const specBudget = spec.budgetLimit ?? input.budgetLimit;
            return {
              task: spec.task,
              type: specType,
              toolAllowlist: intersectAllowlists(
                specAllowlist,
                options.toolAllowlist,
              ),
              promptAppend: spec.promptAppend ?? input.promptAppend,
              // Clamp model-supplied step/dollar budgets per item's type.
              maxSteps:
                specMaxSteps !== undefined
                  ? Math.min(
                      specMaxSteps,
                      2 * getSubagentTypeConfig(specType).defaultMaxSteps,
                    )
                  : undefined,
              budgetLimit:
                specBudget !== undefined
                  ? Math.min(specBudget, budgetCeiling)
                  : undefined,
            };
          }),
          linkedOptions,
        );
        return {
          mode: "parallel",
          results: results.map((r) => ({
            type: r.type,
            model: r.modelUsed,
            cost: r.cost,
            toolCalls: r.toolCalls,
            response: r.text,
          })),
          totalCost: results.reduce((sum, r) => sum + r.cost, 0),
        };
      }

      // Single mode
      if (!input.task) {
        return {
          error:
            'Provide either "task" for single subagent or "parallel" for multiple.',
        };
      }

      const type = input.type as SubagentType;
      // Clamp model-supplied step/dollar budgets before forwarding.
      const maxSteps =
        input.maxSteps !== undefined
          ? Math.min(
              input.maxSteps,
              2 * getSubagentTypeConfig(type).defaultMaxSteps,
            )
          : undefined;
      const budgetLimit =
        input.budgetLimit !== undefined
          ? Math.min(input.budgetLimit, budgetCeiling)
          : undefined;

      // Fall back to trusted options-level values when the model omits a
      // field (a bare spread would clobber them with undefined), and
      // intersect — never replace — a trusted options-level allowlist.
      const result = await spawnSubagent(input.task, {
        ...linkedOptions,
        type,
        toolAllowlist: intersectAllowlists(
          input.toolAllowlist,
          options.toolAllowlist,
        ),
        promptAppend: input.promptAppend ?? linkedOptions.promptAppend,
        maxSteps: maxSteps ?? linkedOptions.maxSteps,
        budgetLimit: budgetLimit ?? linkedOptions.budgetLimit,
      });

      return {
        mode: "single",
        type: result.type,
        model: result.modelUsed,
        cost: result.cost,
        toolCalls: result.toolCalls,
        response: result.text,
      };
    },
  });
}
