import { tool } from 'ai';
import type { ToolPermission } from '@brainstorm/shared';
import type { BrainstormToolDef } from './base.js';

export type PermissionCheckFn = (toolName: string, toolPermission: ToolPermission) => 'allow' | 'confirm' | 'deny';

export class ToolRegistry {
  private tools = new Map<string, BrainstormToolDef>();

  register(tool: BrainstormToolDef): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): BrainstormToolDef | undefined {
    return this.tools.get(name);
  }

  getAll(): BrainstormToolDef[] {
    return Array.from(this.tools.values());
  }

  toAISDKTools(): Record<string, ReturnType<BrainstormToolDef['toAISDKTool']>> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      result[name] = tool.toAISDKTool();
    }
    return result;
  }

  /**
   * Return AI SDK tools filtered to only the named tools.
   * Used by subagent types to restrict tool access.
   */
  toAISDKToolsFiltered(allowedNames: string[]): Record<string, ReturnType<BrainstormToolDef['toAISDKTool']>> {
    const allowed = new Set(allowedNames);
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) {
        result[name] = tool.toAISDKTool();
      }
    }
    return result;
  }

  getPermitted(overrides?: Record<string, ToolPermission>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const permission = overrides?.[name] ?? tool.permission;
      if (permission !== 'deny') {
        result[name] = tool.toAISDKTool();
      }
    }
    return result;
  }

  /**
   * Return AI SDK tools with permission checks wrapping each execute.
   * Tools denied by the check return an error message instead of executing.
   */
  toAISDKToolsWithPermissions(check: PermissionCheckFn): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, toolDef] of this.tools) {
      result[name] = tool({
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        execute: async (input: any) => {
          const decision = check(name, toolDef.permission);
          if (decision === 'deny') {
            return { error: `Tool '${name}' is blocked in the current permission mode.`, blocked: true };
          }
          // 'allow' and 'confirm' (confirm handled upstream by TUI) both proceed
          return toolDef.execute(input);
        },
      });
    }
    return result;
  }

  listTools(): Array<{ name: string; description: string; permission: ToolPermission }> {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
    }));
  }
}
