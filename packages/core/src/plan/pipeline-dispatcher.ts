/**
 * Pipeline Dispatcher — bridges the orchestration pipeline to real subagent execution.
 *
 * Creates a PhaseDispatcher that wires each pipeline phase to `spawnSubagent()`
 * with the correct agent definition, tool set, and budget. The agent's `.agent.md`
 * system prompt is loaded and injected. BrainstormRouter handles model selection
 * automatically — no manual model picking.
 */

import type { PhaseDispatcher } from "./orchestration-pipeline.js";
import {
  spawnSubagent,
  spawnParallel,
  type SubagentOptions,
  type SubagentType,
} from "../agent/subagent.js";
import { findAgentFile } from "@brainst0rm/agents";
import { execFileSync } from "node:child_process";

/**
 * Create a real PhaseDispatcher that executes phases via spawnSubagent().
 *
 * Pass the runtime dependencies (config, registry, router, etc.) and get
 * back a dispatcher that the orchestration pipeline can use.
 */
export function createPipelineDispatcher(
  subagentOptions: SubagentOptions,
): PhaseDispatcher {
  return {
    async runPhase(agentId, subagentType, prompt, opts) {
      // Load agent definition from .agent.md file
      const agentFile = findAgentFile(opts.projectPath, agentId);
      const systemPrompt = agentFile?.profile.systemPrompt;
      const maxSteps = agentFile?.profile.maxSteps;
      const allowedTools = agentFile?.profile.allowedTools;

      // Build the full prompt with agent instructions
      const fullPrompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\nTask:\n${prompt}`
        : prompt;

      // Pass agent-level allowedTools through as the privilege ceiling
      // for the subagent. Pre-fix this was extracted from the profile
      // but NEVER passed — an agent declaring `allowedTools: ["file_read"]`
      // would still have its subagent run shell, git_commit, etc.,
      // because the default subagent type's tool list was used
      // unmodified. Now it flows into parentToolNames, which
      // spawnSubagent intersects with the type's default list (see
      // subagent.ts:367-376) as a strict upper bound.
      //
      // `"all"` means "no restriction" — don't pass parentToolNames
      // so the subagent's type-level defaults apply.
      const parentToolNames =
        allowedTools && allowedTools !== "all" ? allowedTools : undefined;

      const result = await spawnSubagent(fullPrompt, {
        ...subagentOptions,
        type: subagentType as SubagentType,
        systemPrompt: systemPrompt || undefined,
        maxSteps: maxSteps || undefined,
        budgetLimit: opts.budget,
        projectPath: opts.projectPath,
        parentToolNames,
      });

      return {
        text: result.text,
        cost: result.cost,
        toolCalls: result.toolCalls,
      };
    },

    async runParallel(specs, opts) {
      // Collect each spec's agent-level allowedTools and compute the
      // strictest intersection for the shared parentToolNames. spawnParallel
      // accepts ONE options set for all specs — so if agents in the batch
      // have different allowedTools, we take the intersection as a safe
      // floor. "all" contributes no restriction. If any spec declares
      // an explicit tool list, parallel agents are all restricted to
      // tools every agent in the batch can use. Same-batch parallel
      // agents with wildly different restrictions should probably be
      // sequential runPhase calls instead.
      const perAgentAllowed: Array<string[] | undefined> = specs.map((s) => {
        const agentFile = findAgentFile(opts.projectPath, s.agentId);
        const t = agentFile?.profile.allowedTools;
        return t && t !== "all" ? t : undefined;
      });
      const explicitLists = perAgentAllowed.filter(
        (t): t is string[] => t !== undefined,
      );
      let parentToolNames: string[] | undefined;
      if (explicitLists.length > 0) {
        // Intersection of all explicit lists. If any agent has no
        // explicit list ("all"), we can't compute a meaningful
        // intersection for them — so we use the intersection of the
        // ones that DO have lists as the floor for the whole batch.
        parentToolNames = explicitLists.reduce((acc, list) =>
          acc.filter((t) => list.includes(t)),
        );
      }

      const parallelSpecs = specs.map((s) => {
        const agentFile = findAgentFile(opts.projectPath, s.agentId);
        const systemPrompt = agentFile?.profile.systemPrompt;
        const fullPrompt = systemPrompt
          ? `${systemPrompt}\n\n---\n\nTask:\n${s.prompt}`
          : s.prompt;

        return {
          task: fullPrompt,
          type: s.subagentType as SubagentType,
        };
      });

      const results = await spawnParallel(parallelSpecs, {
        ...subagentOptions,
        budgetLimit: opts.budget,
        projectPath: opts.projectPath,
        parentToolNames,
      });

      return results.map((r, i) => ({
        agentId: specs[i].agentId,
        text: r.text,
        cost: r.cost,
        toolCalls: r.toolCalls,
      }));
    },

    async runCommand(command, cwd) {
      const parts = command.split(/\s+/);
      try {
        const output = execFileSync(parts[0], parts.slice(1), {
          cwd,
          timeout: 120000,
          stdio: "pipe",
        });
        return { passed: true, output: output.toString().slice(0, 1000) };
      } catch (err: any) {
        const stderr = err.stderr?.toString()?.slice(0, 1000) ?? "";
        const stdout = err.stdout?.toString()?.slice(0, 500) ?? "";
        return { passed: false, output: `${stderr}\n${stdout}`.trim() };
      }
    },
  };
}
