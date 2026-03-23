import type { ToolPermission } from '@brainstorm/shared';
import type { BrainstormToolDef } from './base.js';

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

  listTools(): Array<{ name: string; description: string; permission: ToolPermission }> {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
    }));
  }
}
