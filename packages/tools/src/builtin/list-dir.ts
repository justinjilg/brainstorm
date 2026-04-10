import { z } from "zod";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../base.js";
import { getWorkspace } from "../workspace-context.js";

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List directory contents with file sizes and types.",
  permission: "auto",
  inputSchema: z.object({
    path: z.string().optional().describe("Directory path (default: current)"),
    recursive: z
      .boolean()
      .optional()
      .describe("List recursively (default: false)"),
  }),
  async execute({ path, recursive }) {
    const dir = path ?? getWorkspace();
    const entries: Array<{ name: string; type: string; size: number }> = [];

    function scan(d: string, prefix = "") {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist"
        )
          continue;
        const fullPath = join(d, entry.name);
        const displayName = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          entries.push({ name: displayName + "/", type: "dir", size: 0 });
          if (recursive) scan(fullPath, displayName);
        } else {
          try {
            const stat = statSync(fullPath);
            entries.push({ name: displayName, type: "file", size: stat.size });
          } catch {
            entries.push({ name: displayName, type: "file", size: 0 });
          }
        }
      }
    }

    scan(dir);
    return {
      entries: entries.slice(0, 200),
      total: entries.length,
      truncated: entries.length > 200,
    };
  },
});
