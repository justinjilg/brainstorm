/**
 * Java Language Adapter.
 *
 * Handles: method_declaration, class_declaration, method_invocation,
 * import_declaration.
 */

import Parser from "tree-sitter";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { LanguageAdapter } from "./types.js";
import type { ParsedFile } from "../parser.js";

const require = createRequire(import.meta.url);
let javaParser: Parser | null = null;

export function createJavaAdapter(): LanguageAdapter {
  return {
    id: "java",
    extensions: [".java"],
    treeSitterPackage: "tree-sitter-java",

    getParser(): Parser {
      if (!javaParser) {
        javaParser = new Parser();
        const Java = require("tree-sitter-java");
        javaParser.setLanguage(Java);
      }
      return javaParser;
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
        language: "java",
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
  currentMethod: string | null,
  currentClass: string | null,
): void {
  switch (node.type) {
    case "class_declaration":
    case "interface_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const isPublic = node.children.some(
        (c) => c.type === "modifiers" && c.text.includes("public"),
      );
      result.classes.push({
        name,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: isPublic,
      });
      for (const child of node.children) {
        walk(child, result, currentMethod, name);
      }
      return;
    }

    case "method_declaration":
    case "constructor_declaration": {
      const name =
        node.childForFieldName("name")?.text ??
        (node.type === "constructor_declaration" ? "<init>" : "<anonymous>");
      const params = node.childForFieldName("parameters")?.text ?? "()";
      const returnType = node.childForFieldName("type")?.text;
      const modifiers =
        node.children.find((c) => c.type === "modifiers")?.text ?? "";

      if (currentClass) {
        result.methods.push({
          name,
          className: currentClass,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isStatic: modifiers.includes("static"),
          isAsync: false,
        });
      } else {
        result.functions.push({
          name,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: `${returnType ?? "void"} ${name}${params}`,
          isExported: modifiers.includes("public"),
          isAsync: false,
        });
      }

      const callerName = currentClass ? `${currentClass}.${name}` : name;
      for (const child of node.children) {
        walk(child, result, callerName, currentClass);
      }
      return;
    }

    case "method_invocation": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        result.callSites.push({
          callerName: currentMethod,
          calleeName: name,
          file: result.file,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }

    case "object_creation_expression": {
      const typeName = node.childForFieldName("type")?.text;
      if (typeName) {
        result.callSites.push({
          callerName: currentMethod,
          calleeName: `new ${typeName}`,
          file: result.file,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }

    case "import_declaration": {
      const pathNode = node.children.find(
        (c) => c.type === "scoped_identifier",
      );
      if (pathNode) {
        const fullPath = pathNode.text;
        const name = fullPath.split(".").pop() ?? fullPath;
        result.imports.push({
          file: result.file,
          source: fullPath,
          names: [name],
          isDefault: false,
        });
      }
      return;
    }
  }

  for (const child of node.children) {
    walk(child, result, currentMethod, currentClass);
  }
}
