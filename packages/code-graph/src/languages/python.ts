/**
 * Python Language Adapter.
 */

import Parser from "tree-sitter";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { LanguageAdapter } from "./types.js";
import type { ParsedFile } from "../parser.js";

const require = createRequire(import.meta.url);
let pyParser: Parser | null = null;

export function createPythonAdapter(): LanguageAdapter {
  return {
    id: "python",
    extensions: [".py", ".pyi"],
    treeSitterPackage: "tree-sitter-python",

    getParser(): Parser {
      if (!pyParser) {
        pyParser = new Parser();
        const Python = require("tree-sitter-python");
        pyParser.setLanguage(Python);
      }
      return pyParser;
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
        language: "python",
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
  currentClass: string | null,
): void {
  switch (node.type) {
    case "function_definition": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const isAsync = node.children.some((c) => c.type === "async");
      const params = node.childForFieldName("parameters")?.text ?? "()";
      const returnType = node.childForFieldName("return_type")?.text;
      const signature = `def ${name}${params}${returnType ? ` -> ${returnType}` : ""}`;

      // If inside a class, treat as method
      if (currentClass) {
        result.methods.push({
          name,
          className: currentClass,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isStatic: hasDecorator(node, "staticmethod"),
          isAsync,
        });
        const callerName = `${currentClass}.${name}`;
        for (const child of node.children) {
          walk(child, result, callerName, currentClass);
        }
      } else {
        result.functions.push({
          name,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature,
          isExported: true, // Python doesn't have explicit exports
          isAsync,
        });
        for (const child of node.children) {
          walk(child, result, name, currentClass);
        }
      }
      return;
    }

    case "class_definition": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      result.classes.push({
        name,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: true,
      });
      for (const child of node.children) {
        walk(child, result, currentFunction, name);
      }
      return;
    }

    case "call": {
      const fn = node.childForFieldName("function");
      let calleeName: string | null = null;
      if (fn?.type === "identifier") {
        calleeName = fn.text;
      } else if (fn?.type === "attribute") {
        calleeName = fn.childForFieldName("attribute")?.text ?? null;
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

    case "import_from_statement": {
      const module = node.children
        .filter((c) => c.type === "dotted_name")
        .map((c) => c.text);
      const source = module[0] ?? "";
      const names: string[] = [];
      for (const child of node.children) {
        if (
          child.type === "dotted_name" &&
          child !== node.children.find((c) => c.type === "dotted_name")
        ) {
          names.push(child.text);
        } else if (child.type === "import_prefix") {
          // from . import x
        }
      }
      // Try to get imported names from import list
      for (const child of node.children) {
        if (child.type === "import_list" || child.type === "aliased_import") {
          for (const spec of child.children) {
            if (spec.type === "dotted_name") names.push(spec.text);
            if (spec.type === "aliased_import") {
              const importedName = spec.childForFieldName("name")?.text;
              if (importedName) names.push(importedName);
            }
          }
        }
      }
      if (source) {
        result.imports.push({
          file: result.file,
          source,
          names,
          isDefault: false,
        });
      }
      return;
    }

    case "import_statement": {
      for (const child of node.children) {
        if (child.type === "dotted_name") {
          result.imports.push({
            file: result.file,
            source: child.text,
            names: [child.text.split(".").pop() ?? child.text],
            isDefault: true,
          });
        }
      }
      return;
    }
  }

  for (const child of node.children) {
    walk(child, result, currentFunction, currentClass);
  }
}

function hasDecorator(node: Parser.SyntaxNode, name: string): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // Check preceding siblings for decorator
  const idx = parent.children.indexOf(node);
  for (let i = idx - 1; i >= 0; i--) {
    const sibling = parent.children[i];
    if (sibling.type === "decorator") {
      if (sibling.text.includes(name)) return true;
    } else {
      break;
    }
  }
  return false;
}
