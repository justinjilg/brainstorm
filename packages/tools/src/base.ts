import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolPermission } from '@brainstorm/shared';

export interface BrainstormToolDef<TOutput = unknown> {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: z.ZodObject<any>;
  execute: (input: any) => Promise<TOutput>;
  toAISDKTool: () => ToolSet[string];
}

export function defineTool<T extends z.ZodObject<any>, TOutput>(config: {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: T;
  execute: (input: z.infer<T>) => Promise<TOutput>;
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
