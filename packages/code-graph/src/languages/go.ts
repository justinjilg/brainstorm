/**
 * Go Language Adapter.
 *
 * Handles: function_declaration, method_declaration (with receiver),
 * call_expression, import_declaration.
 */

import Parser from "tree-sitter";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { LanguageAdapter } from "./types.js";
import type { ParsedFile } from "../parser.js";

const require = createRequire(import.meta.url);
let goParser: Parser | null = null;

export function createGoAdapter(): LanguageAdapter {
  return {
    id: "go",
    extensions: [".go"],
    treeSitterPackage: "tree-sitter-go",

    getParser(): Parser {
      if (!goParser) {
        goParser = new Parser();
        const Go = require("tree-sitter-go");
        goParser.setLanguage(Go);
      }
      return goParser;
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
        language: "go",
        functions: [],
        classes: [],
        methods: [],
        callSites: [],
        imports: [],
      };

      walk(tree.rootNode, result, null);
      return result;
    },
  };
}

function walk(
  node: Parser.SyntaxNode,
  result: ParsedFile,
  currentFunction: string | null,
): void {
  switch (node.type) {
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const params = node.childForFieldName("parameters")?.text ?? "()";
      const returnType = node.childForFieldName("result")?.text;
      const signature = `func ${name}${params}${returnType ? " " + returnType : ""}`;

      result.functions.push({
        name,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature,
        isExported: name[0] === name[0].toUpperCase(),
        isAsync: false, // Go uses goroutines, not async
      });

      for (const child of node.children) {
        walk(child, result, name);
      }
      return;
    }

    case "method_declaration": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const receiver = node.childForFieldName("receiver");
      let className = "<unknown>";
      if (receiver) {
        // Extract type name from receiver: (r *Router) → "Router"
        const typeNode = receiver.descendantsOfType("type_identifier")[0];
        if (typeNode) className = typeNode.text;
      }

      result.methods.push({
        name,
        className,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isStatic: false,
        isAsync: false,
      });

      const callerName = `${className}.${name}`;
      for (const child of node.children) {
        walk(child, result, callerName);
      }
      return;
    }

    case "type_declaration": {
      // type Foo struct { ... }
      for (const spec of node.children) {
        if (spec.type === "type_spec") {
          const name = spec.childForFieldName("name")?.text;
          const typeBody = spec.childForFieldName("type");
          if (name && typeBody?.type === "struct_type") {
            result.classes.push({
              name,
              file: result.file,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              isExported: name[0] === name[0].toUpperCase(),
            });
          }
        }
      }
      break;
    }

    case "call_expression": {
      const fn = node.childForFieldName("function");
      let calleeName: string | null = null;
      if (fn?.type === "identifier") {
        calleeName = fn.text;
      } else if (fn?.type === "selector_expression") {
        calleeName = fn.childForFieldName("field")?.text ?? null;
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

    case "import_declaration": {
      for (const spec of node.descendantsOfType("import_spec")) {
        const path = spec.childForFieldName("path")?.text;
        if (path) {
          const cleanPath = path.replace(/"/g, "");
          const name = cleanPath.split("/").pop() ?? cleanPath;
          result.imports.push({
            file: result.file,
            source: cleanPath,
            names: [name],
            isDefault: true,
          });
        }
      }
      return;
    }
  }

  for (const child of node.children) {
    walk(child, result, currentFunction);
  }
}
