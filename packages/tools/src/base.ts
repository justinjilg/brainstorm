import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolPermission } from "@brainst0rm/shared";

/**
 * Per-tool-call context surfaced by the AI SDK. The abortSignal is the
 * one passed to streamText — when the surrounding agent loop aborts
 * (user Ctrl+C, HTTP disconnect, budget exceeded), this signal fires
 * and tools can honour it to stop in-flight work.
 */
export interface ToolExecuteContext {
  abortSignal?: AbortSignal;
}

/**
 * Descriptive metadata fields the tool registry exposes to generators
 * (docs/tool-catalog.json, MCP wrappers, headless-runner gates). These
 * fields used to live in hand-maintained side-tables inside
 * `export-catalog.ts`; the lockstep gate test now requires every
 * registered tool to declare them (inline or via the central
 * `BUILTIN_TOOL_METADATA` table in `builtin/_metadata.ts`).
 *
 * Design rationale: "move lockstep from discipline to mechanism" —
 * borrowed verbatim from BrainstormRouter's contract compiler header
 * (brainstormrouter/src/api/capability-def.ts).
 */
export interface ToolMetadata {
  /** Coarse grouping for catalog/docs surfaces (e.g. "filesystem", "git"). */
  category: string;
  /** Free-form tags for search and routing heuristics. */
  tags?: string[];
  /**
   * True if this tool is safe to call in a non-interactive run
   * (`brainstorm run`, headless daemon). False means the tool blocks on
   * a UI/user-input event and will deadlock.
   */
  headlessSafe: boolean;
  /**
   * Free-form note explaining multi-step / interactive / mode-specific
   * protocol expectations. Rendered into docs and headless-runner
   * diagnostics. Optional — most tools don't need one.
   */
  protocol?: string;
}

export interface BrainstormToolDef<
  TOutput = unknown,
> extends Partial<ToolMetadata> {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: z.ZodObject<any>;
  execute: (input: any, ctx?: ToolExecuteContext) => Promise<TOutput>;
  toAISDKTool: () => ToolSet[string];
  /** True if this tool is safe for parallel execution (no side effects). */
  concurrent?: boolean;
  /** True if this tool performs no mutations (read-only). */
  readonly?: boolean;
  /** True if this tool's schema is deferred (loaded on demand via ToolSearch). */
  deferred?: boolean;
}

export function defineTool<T extends z.ZodObject<any>, TOutput>(config: {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: T;
  execute: (input: z.infer<T>, ctx?: ToolExecuteContext) => Promise<TOutput>;
  concurrent?: boolean;
  readonly?: boolean;
  category?: string;
  tags?: string[];
  headlessSafe?: boolean;
  protocol?: string;
}): BrainstormToolDef<TOutput> {
  return {
    ...config,
    toAISDKTool() {
      return tool({
        description: config.description,
        inputSchema: config.inputSchema,
        execute: ((input: any, aiCtx: any) =>
          config.execute(input, {
            abortSignal: aiCtx?.abortSignal,
          })) as any,
      });
    },
  };
}
