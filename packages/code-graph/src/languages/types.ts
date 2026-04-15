/**
 * Language Adapter Interface — each supported language implements this.
 *
 * Adapters translate language-specific AST node types into the universal
 * ParsedFile representation (FunctionDef, ClassDef, MethodDef, CallSite, ImportDecl).
 * This keeps the knowledge graph language-agnostic.
 */

import type Parser from "tree-sitter";
import type { ParsedFile } from "../parser.js";

export interface LanguageAdapter {
  /** Language identifier (e.g., "typescript", "python", "go"). */
  id: string;
  /** File extensions this adapter handles (e.g., [".ts", ".tsx"]). */
  extensions: string[];
  /** npm package name for the tree-sitter grammar. */
  treeSitterPackage: string;
  /**
   * Get a configured parser for a specific file extension.
   * Some languages need different grammars per extension (e.g., .ts vs .tsx).
   */
  getParser(ext?: string): Parser;
  /** Extract structural info from a parsed tree. */
  extractNodes(
    tree: Parser.Tree,
    filePath: string,
    content: string,
  ): ParsedFile;
}
