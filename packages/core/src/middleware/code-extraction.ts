/**
 * Code Extraction Middleware — strips markdown fences from LLM code output.
 *
 * LLMs consistently wrap code in ```language ... ``` even when told not to.
 * This middleware intercepts file_write and file_edit tool calls where the
 * target is a code file, and strips markdown fences from the content before
 * the file is written to disk.
 *
 * Learned from: Living Case Study orchestrator — every .go file was written
 * as a markdown document containing code fences. This middleware prevents that.
 */

import type { AgentMiddleware, MiddlewareToolCall } from "./types.js";

const CODE_EXTENSIONS = new Set([
  ".go",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".swift",
  ".kt",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".proto",
  ".graphql",
]);

const YAML_EXTENSIONS = new Set([".yaml", ".yml", ".toml"]);

function isCodeFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf("."));
  return CODE_EXTENSIONS.has(ext) || YAML_EXTENSIONS.has(ext);
}

/**
 * Extract raw code from content that may be wrapped in markdown fences.
 * Handles: single fence, multiple fences, leading/trailing commentary.
 */
export function extractCodeContent(
  text: string,
  filePath: string,
): { cleaned: string; modified: boolean } {
  const original = text;
  let cleaned = text.trim();

  // Quick check — if it starts with a valid code line, no extraction needed
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (ext === ".go" && cleaned.startsWith("package "))
    return { cleaned: original, modified: false };
  if (
    (ext === ".ts" || ext === ".tsx" || ext === ".js") &&
    (cleaned.startsWith("import ") ||
      cleaned.startsWith("export ") ||
      cleaned.startsWith("'use ") ||
      cleaned.startsWith('"use '))
  )
    return { cleaned: original, modified: false };
  if (
    ext === ".py" &&
    (cleaned.startsWith("import ") ||
      cleaned.startsWith("from ") ||
      cleaned.startsWith("def ") ||
      cleaned.startsWith("class ") ||
      cleaned.startsWith("#!"))
  )
    return { cleaned: original, modified: false };
  if (
    YAML_EXTENSIONS.has(ext) &&
    !cleaned.startsWith("```") &&
    !cleaned.startsWith("<!--")
  )
    return { cleaned: original, modified: false };

  // Strip HTML comments (BR metadata headers in markdown-wrapped files)
  cleaned = cleaned.replace(/^<!--[\s\S]*?-->\n*/gm, "").trim();

  // Remove leading prose before the first code fence or code-like line
  const codePatterns =
    /^(```|package |import |from |export |def |class |func |type |const |var |module |use |#!|name:|id:)/m;
  const codeStart = cleaned.search(codePatterns);
  if (codeStart > 0) {
    cleaned = cleaned.slice(codeStart);
  }

  // Extract from markdown code fences
  const fenceRegex = /```\w*\n([\s\S]*?)\n```/g;
  const blocks: string[] = [];
  let match;
  while ((match = fenceRegex.exec(cleaned)) !== null) {
    blocks.push(match[1].trim());
  }

  if (blocks.length > 0) {
    cleaned = blocks.join("\n\n");
  } else {
    // Single fence without closing — strip the opening fence
    cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
  }

  // Strip trailing prose after Go code (after last })
  if (ext === ".go") {
    const lastBrace = cleaned.lastIndexOf("}");
    if (lastBrace > 0 && lastBrace < cleaned.length - 5) {
      const after = cleaned.slice(lastBrace + 1).trim();
      if (
        after.length > 50 &&
        !after.startsWith("//") &&
        !after.startsWith("func")
      ) {
        cleaned = cleaned.slice(0, lastBrace + 1);
      }
    }
  }

  cleaned = cleaned.trim() + "\n";
  const modified = cleaned !== original;
  return { cleaned, modified };
}

export const codeExtractionMiddleware: AgentMiddleware = {
  name: "code-extraction",

  wrapToolCall(call: MiddlewareToolCall): MiddlewareToolCall | void {
    // Only intercept file_write and file_edit for code files
    if (call.name !== "file_write" && call.name !== "file_edit") return;

    const path = call.input.path as string | undefined;
    const content = call.input.content as string | undefined;

    if (!path || !content || !isCodeFile(path)) return;

    const { cleaned, modified } = extractCodeContent(content, path);
    if (!modified) return;

    // Return modified call with cleaned content
    return {
      ...call,
      input: { ...call.input, content: cleaned },
    };
  },
};
