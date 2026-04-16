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

export interface BrainstormToolDef<TOutput = unknown> {
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
