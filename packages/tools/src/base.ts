import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolPermission } from "@brainst0rm/shared";

export interface BrainstormToolDef<TOutput = unknown> {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: z.ZodObject<any>;
  execute: (input: any) => Promise<TOutput>;
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
  execute: (input: z.infer<T>) => Promise<TOutput>;
  concurrent?: boolean;
  readonly?: boolean;
}): BrainstormToolDef<TOutput> {
  return {
    ...config,
    toAISDKTool() {
      return tool({
        description: config.description,
        inputSchema: config.inputSchema,
        execute: config.execute as any,
      });
    },
  };
}
