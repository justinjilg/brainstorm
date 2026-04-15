/**
 * Rust Language Adapter.
 *
 * Handles: function_item, impl_item methods, call_expression,
 * macro_invocation, use_declaration.
 */

import Parser from "tree-sitter";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { LanguageAdapter } from "./types.js";
import type { ParsedFile } from "../parser.js";

const require = createRequire(import.meta.url);
let rustParser: Parser | null = null;

export function createRustAdapter(): LanguageAdapter {
  return {
    id: "rust",
    extensions: [".rs"],
    treeSitterPackage: "tree-sitter-rust",

    getParser(): Parser {
      if (!rustParser) {
        rustParser = new Parser();
        const Rust = require("tree-sitter-rust");
        rustParser.setLanguage(Rust);
      }
      return rustParser;
    },

    extractNodes(
      tree: Parser.Tree,
      filePath: string,
      content: string,
    ): ParsedFile {
      const contentHash = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16);

      const result: ParsedFile = {
        file: filePath,
        contentHash,
        language: "rust",
        functions: [],
        classes: [],
        methods: [],
        callSites: [],
        imports: [],
      };

      walk(tree.rootNode, result, null, null);
      return result;
    },
  };
}

function walk(
  node: Parser.SyntaxNode,
  result: ParsedFile,
  currentFunction: string | null,
  currentImpl: string | null,
): void {
  switch (node.type) {
    case "function_item": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const params = node.childForFieldName("parameters")?.text ?? "()";
      const returnType = node.childForFieldName("return_type")?.text;
      const isPublic = node.children.some(
        (c) => c.type === "visibility_modifier",
      );
      const isAsync = node.descendantsOfType("async").length > 0;
      const signature = `fn ${name}${params}${returnType ? " -> " + returnType : ""}`;

      if (currentImpl) {
        result.methods.push({
          name,
          className: currentImpl,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isStatic: !params.includes("self"),
          isAsync,
        });
        const callerName = `${currentImpl}::${name}`;
        for (const child of node.children) {
          walk(child, result, callerName, currentImpl);
        }
      } else {
        result.functions.push({
          name,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature,
          isExported: isPublic,
          isAsync,
        });
        for (const child of node.children) {
          walk(child, result, name, currentImpl);
        }
      }
      return;
    }

    case "impl_item": {
      const typeName = node.childForFieldName("type")?.text ?? "<unknown>";
      // Treat impl blocks like classes
      result.classes.push({
        name: typeName,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: false, // visibility is per-method in Rust
      });
      for (const child of node.children) {
        walk(child, result, currentFunction, typeName);
      }
      return;
    }

    case "struct_item":
    case "enum_item": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        result.classes.push({
          name,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some(
            (c) => c.type === "visibility_modifier",
          ),
        });
      }
      break;
    }

    case "call_expression": {
      const fn = node.childForFieldName("function");
      let calleeName: string | null = null;
      if (fn?.type === "identifier") {
        calleeName = fn.text;
      } else if (fn?.type === "field_expression") {
        calleeName = fn.childForFieldName("field")?.text ?? null;
      } else if (fn?.type === "scoped_identifier") {
        calleeName = fn.childForFieldName("name")?.text ?? null;
      }
      if (calleeName) {
        result.callSites.push({
          callerName: currentFunction,
          calleeName,
          file: result.file,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }

    case "macro_invocation": {
      const macroName = node.childForFieldName("macro")?.text;
      if (macroName) {
        result.callSites.push({
          callerName: currentFunction,
          calleeName: macroName + "!",
          file: result.file,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }

    case "use_declaration": {
      const path = node.descendantsOfType("scoped_identifier");
      for (const p of path) {
        const source = p.text;
        const name =
          p.childForFieldName("name")?.text ??
          source.split("::").pop() ??
          source;
        result.imports.push({
          file: result.file,
          source,
          names: [name],
          isDefault: false,
        });
      }
      // Also handle simple identifier uses
      for (const child of node.children) {
        if (child.type === "identifier") {
          result.imports.push({
            file: result.file,
            source: child.text,
            names: [child.text],
            isDefault: false,
          });
        }
      }
      return;
    }
  }

  for (const child of node.children) {
    walk(child, result, currentFunction, currentImpl);
  }
}
