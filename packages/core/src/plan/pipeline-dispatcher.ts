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

      const result = await spawnSubagent(fullPrompt, {
        ...subagentOptions,
        type: subagentType as SubagentType,
        systemPrompt: systemPrompt || undefined,
        maxSteps: maxSteps || undefined,
        budgetLimit: opts.budget,
        projectPath: opts.projectPath,
      });

      return {
        text: result.text,
        cost: result.cost,
        toolCalls: result.toolCalls,
      };
    },

    async runParallel(specs, opts) {
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
