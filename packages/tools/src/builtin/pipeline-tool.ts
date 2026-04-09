/**
 * Pipeline Dispatch Tool — allows the daemon agent to invoke the
 * 9-phase orchestration pipeline as a structured operation.
 *
 * When KAIROS is running autonomously, the agent can call this tool
 * to dispatch a multi-phase software development lifecycle:
 * spec → implementation → review (parallel) → verify → document
 *
 * Like the memory tool, this is a stub that gets wired at runtime
 * with a real PhaseDispatcher via createWiredPipelineTool().
 */

import { z } from "zod";
import { defineTool } from "../base.js";

export const pipelineTool = defineTool({
  name: "pipeline_dispatch",
  description:
    "Dispatch a structured multi-phase development pipeline. " +
    "Phases: spec → implementation → review (3 parallel reviewers) → verify → document. " +
    "Use this for complex tasks that benefit from structured execution with specialized agents. " +
    "The pipeline automatically selects which phases to run based on the request.",
  permission: "confirm",
  inputSchema: z.object({
    request: z
      .string()
      .describe(
        "What to build/fix/refactor. Be specific — this drives phase selection and agent prompts.",
      ),
    phases: z
      .array(z.string())
      .optional()
      .describe(
        "Override phase selection. Default: auto-selected. Options: spec, implementation, review, verify, document",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, show what agents would be dispatched without running them",
      ),
  }),
  async execute(input) {
    return {
      error:
        "Pipeline tool not wired. This tool must be connected to a PhaseDispatcher at runtime.",
    };
  },
});

/**
 * Create a pipeline tool wired to a real PhaseDispatcher.
 * Called during daemon/chat session initialization.
 */
export function createWiredPipelineTool(
  runPipeline: (
    request: string,
    opts?: { phases?: string[]; dryRun?: boolean },
  ) => Promise<{
    phases: Array<{ phase: string; output: string; cost: number }>;
    totalCost: number;
  }>,
) {
  return defineTool({
    name: "pipeline_dispatch",
    description: pipelineTool.description,
    permission: "confirm",
    inputSchema: pipelineTool.inputSchema,
    async execute(input) {
      try {
        const result = await runPipeline(input.request, {
          phases: input.phases,
          dryRun: input.dryRun,
        });

        if (input.dryRun) {
          return {
            dryRun: true,
            phases: result.phases.map((p) => p.phase),
            message: `Would dispatch ${result.phases.length} phases: ${result.phases.map((p) => p.phase).join(" → ")}`,
          };
        }

        return {
          completed: true,
          phases: result.phases.map((p) => ({
            phase: p.phase,
            outputPreview: p.output.slice(0, 200),
            cost: p.cost,
          })),
          totalCost: result.totalCost,
          message: `Pipeline completed: ${result.phases.length} phases, $${result.totalCost.toFixed(4)} total cost`,
        };
      } catch (err: any) {
        return {
          error: `Pipeline failed: ${err.message}`,
        };
      }
    },
  });
}
