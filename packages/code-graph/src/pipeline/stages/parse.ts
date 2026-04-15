/**
 * Parse Stage — runs tree-sitter on all discovered files.
 *
 * Uses the language adapter registry to dispatch each file to the
 * appropriate parser. Content-hash change detection avoids re-parsing
 * unchanged files.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createHash } from "node:crypto";
import { getAdapterForExtension } from "../../languages/registry.js";
import type { ParsedFile } from "../../parser.js";
import type { PipelineStage, PipelineContext } from "../types.js";
import type { ScanResult } from "./scan.js";

export interface ParseResult {
  parsed: ParsedFile[];
  errors: number;
  skipped: number;
}

export const parseStage: PipelineStage = {
  id: "parse",
  name: "AST Parsing",
  dependsOn: ["scan"],

  async run(ctx: PipelineContext): Promise<ParseResult> {
    const scanResult = ctx.results.get("scan") as ScanResult;
    if (!scanResult) throw new Error("scan stage output missing");

    const parsed: ParsedFile[] = [];
    let errors = 0;
    let skipped = 0;

    for (let i = 0; i < scanResult.files.length; i++) {
      const file = scanResult.files[i];
      const ext = extname(file.path);
      const adapter = getAdapterForExtension(ext);

      if (!adapter) {
        skipped++;
        continue;
      }

      try {
        const content = readFileSync(file.path, "utf-8");
        const contentHash = createHash("sha256")
          .update(content)
          .digest("hex")
          .slice(0, 16);

        // Check if already parsed with same content hash
        const existing = ctx.graph
          .getDb()
          .prepare("SELECT content_hash FROM files WHERE path = ?")
          .get(file.path) as { content_hash: string } | undefined;

        if (existing?.content_hash === contentHash) {
          skipped++;
          continue;
        }

        const tree = adapter.getParser(ext).parse(content);
        const result = adapter.extractNodes(tree, file.path, content);
        parsed.push(result);

        if ((i + 1) % 50 === 0) {
          ctx.onProgress?.(
            "parse",
            `Parsed ${i + 1}/${scanResult.files.length} files`,
          );
        }
      } catch {
        errors++;
      }
    }

    ctx.onProgress?.(
      "parse",
      `Parsed ${parsed.length} files (${skipped} unchanged, ${errors} errors)`,
    );
    return { parsed, errors, skipped };
  },
};
