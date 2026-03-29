import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import {
  spawnSubagent,
  spawnParallel,
  SUBAGENT_TYPE_NAMES,
  type SubagentOptions,
  type SubagentType,
} from "./subagent.js";

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
      'Pass multiple items to the "parallel" array to run several subagents concurrently.',
    permission: "auto",
    inputSchema: z.object({
      task: z
        .string()
        .optional()
        .describe(
          "Task prompt for a single subagent. Use this OR parallel, not both.",
        ),
      type: z
        .enum([
          "explore",
          "plan",
          "code",
          "review",
          "general",
          "decompose",
          "external",
        ])
        .default("general")
        .describe(
          "Subagent type — determines available tools, system prompt, and model selection.",
        ),
      parallel: z
        .array(
          z.object({
            task: z.string().describe("Task prompt for this subagent."),
            type: z
              .enum([
                "explore",
                "plan",
                "code",
                "review",
                "general",
                "decompose",
                "external",
              ])
              .default("general")
              .describe("Subagent type for this task."),
          }),
        )
        .optional()
        .describe(
          "Run multiple subagents in parallel. Each gets its own context.",
        ),
    }),
    execute: async (input) => {
      // Parallel mode: multiple subagents at once
      if (input.parallel && input.parallel.length > 0) {
        const results = await spawnParallel(
          input.parallel.map((spec) => ({
            task: spec.task,
            type: spec.type as SubagentType,
          })),
          options,
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

      const result = await spawnSubagent(input.task, {
        ...options,
        type: input.type as SubagentType,
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
