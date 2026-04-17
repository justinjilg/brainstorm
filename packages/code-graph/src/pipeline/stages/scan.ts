/**
 * Scan Stage — discovers all parseable files in the project.
 */

import { readdirSync, lstatSync } from "node:fs";
import { join, extname } from "node:path";
import { supportedExtensions } from "../../languages/registry.js";
import type { PipelineStage, PipelineContext } from "../types.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "build",
  ".turbo",
  "coverage",
  ".next",
  ".cache",
  "out",
  "__pycache__",
  ".mypy_cache",
  "target",
  "vendor",
  ".gradle",
]);

export interface ScanResult {
  files: Array<{ path: string; ext: string; sizeBytes: number }>;
  totalFiles: number;
  skippedDirs: number;
}

export const scanStage: PipelineStage = {
  id: "scan",
  name: "File Discovery",
  dependsOn: [],

  async run(ctx: PipelineContext): Promise<ScanResult> {
    const extensions = supportedExtensions();
    const files: ScanResult["files"] = [];
    let skippedDirs = 0;

    const stack: string[] = [ctx.projectPath];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.startsWith(".") && entry !== ".brainstorm") continue;
        const fullPath = join(dir, entry);
        let stat;
        try {
          // lstat, not stat — don't follow symlinks (cycle safety).
          stat = lstatSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry)) {
            skippedDirs++;
            continue;
          }
          stack.push(fullPath);
          continue;
        }

        if (!stat.isFile()) continue;
        if (entry.endsWith(".d.ts")) continue;

        const ext = extname(entry);
        if (extensions.has(ext)) {
          files.push({ path: fullPath, ext, sizeBytes: stat.size });
        }
      }
    }

    ctx.onProgress?.("scan", `Found ${files.length} parseable files`);
    return { files, totalFiles: files.length, skippedDirs };
  },
};
