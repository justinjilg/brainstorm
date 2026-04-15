/**
 * TypeScript/TSX Language Adapter.
 *
 * Extracted from the original parser.ts. Handles:
 * - function_declaration + generator_function_declaration
 * - class_declaration + method_definition
 * - arrow_function, function_expression, generator_function (assignments)
 * - call_expression → identifier or member_expression.property
 * - import_statement
 */

import Parser from "tree-sitter";
// @ts-ignore - no type declarations
import TypeScript from "tree-sitter-typescript";
import { createHash } from "node:crypto";
import type { LanguageAdapter } from "./types.js";
import type {
  ParsedFile,
  FunctionDef,
  ClassDef,
  MethodDef,
  CallSite,
  ImportDecl,
} from "../parser.js";

let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;

function getTsParser(): Parser {
  if (!tsParser) {
    tsParser = new Parser();
    tsParser.setLanguage(TypeScript.typescript as any);
  }
  return tsParser;
}

function getTsxParser(): Parser {
  if (!tsxParser) {
    tsxParser = new Parser();
    tsxParser.setLanguage(TypeScript.tsx as any);
  }
  return tsxParser;
}

export function createTypeScriptAdapter(): LanguageAdapter {
  return {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    treeSitterPackage: "tree-sitter-typescript",

    getParser(ext?: string): Parser {
      return ext === ".tsx" ? getTsxParser() : getTsParser();
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
        language: "typescript",
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

/**
 * Parse a TypeScript/TSX file using the appropriate parser.
 * Called by the registry dispatcher in parser.ts.
 */
export function parseTypeScript(
  filePath: string,
  content: string,
): { tree: Parser.Tree; parser: Parser } {
  const useTsx = filePath.endsWith(".tsx") || filePath.endsWith(".mtsx");
  const p = useTsx ? getTsxParser() : getTsParser();
  return { tree: p.parse(content), parser: p };
}

// ── AST Walking ───────────────────────────────────────────────────

function walk(
  node: Parser.SyntaxNode,
  result: ParsedFile,
  currentFunction: string | null,
  currentClass: string | null,
): void {
  switch (node.type) {
    // function_declaration: regular `function foo() {}`
    // generator_function_declaration: `function* foo() {}` (used by runAgentLoop etc.)
    // Both need the same handling — extract the name and track as enclosing function.
    // Without generator_function_declaration here, every call inside a generator
    // function gets caller=null, which collapses impactAnalysis to 0 results.
    case "function_declaration":
    case "generator_function_declaration": {
      const name = getChildText(node, "name") ?? "<anonymous>";
      const exportParent =
        node.parent?.type === "export_statement" ||
        node.parent?.parent?.type === "export_statement";
      const isAsync = hasChildType(node, "async");
      const signature = getSignature(node);
      result.functions.push({
        name,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature,
        isExported: exportParent,
        isAsync,
      });
      for (const child of node.children) {
        walk(child, result, name, currentClass);
      }
      return;
    }

    case "class_declaration": {
      const name = getChildText(node, "name") ?? "<anonymous>";
      const isExported = node.parent?.type === "export_statement";
      result.classes.push({
        name,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported,
      });
      for (const child of node.children) {
        walk(child, result, currentFunction, name);
      }
      return;
    }

    case "method_definition": {
      const name = getChildText(node, "name") ?? "<anonymous>";
      if (currentClass) {
        result.methods.push({
          name,
          className: currentClass,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isStatic: hasChildType(node, "static"),
          isAsync: hasChildType(node, "async"),
        });
      }
      const callerName = currentClass ? `${currentClass}.${name}` : name;
      for (const child of node.children) {
        walk(child, result, callerName, currentClass);
      }
      return;
    }

    case "call_expression": {
      const calleeName = extractCalleeName(node);
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

    case "import_statement": {
      const imp = parseImport(node, result.file);
      if (imp) result.imports.push(imp);
      return;
    }

    case "arrow_function":
    case "function_expression":
    case "generator_function": {
      let assignedName: string | null = null;
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        assignedName = getChildText(parent, "name");
      } else if (
        parent?.type === "pair" ||
        parent?.type === "property_signature"
      ) {
        assignedName = getChildText(parent, "key");
      } else if (parent?.type === "public_field_definition") {
        assignedName = getChildText(parent, "name");
      }
      if (assignedName) {
        result.functions.push({
          name: assignedName,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: getSignature(node),
          isExported: false,
          isAsync: hasChildType(node, "async"),
        });
      }
      for (const child of node.children) {
        walk(child, result, assignedName ?? currentFunction, currentClass);
      }
      return;
    }
  }

  for (const child of node.children) {
    walk(child, result, currentFunction, currentClass);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function getChildText(
  node: Parser.SyntaxNode,
  fieldName: string,
): string | null {
  return node.childForFieldName(fieldName)?.text ?? null;
}

function hasChildType(node: Parser.SyntaxNode, type: string): boolean {
  return node.children.some((c) => c.type === type);
}

function getSignature(node: Parser.SyntaxNode): string {
  const text = node.text;
  const braceIdx = text.indexOf("{");
  const arrowIdx = text.indexOf("=>");
  const endIdx =
    braceIdx > 0 && (arrowIdx < 0 || braceIdx < arrowIdx)
      ? braceIdx
      : arrowIdx > 0
        ? arrowIdx
        : Math.min(text.length, 200);
  return text.slice(0, endIdx).trim().slice(0, 200);
}

function extractCalleeName(node: Parser.SyntaxNode): string | null {
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  switch (fn.type) {
    case "identifier":
      return fn.text;
    case "member_expression": {
      const property = fn.childForFieldName("property");
      return property?.text ?? null;
    }
    case "subscript_expression":
      return null;
    default:
      return null;
  }
}

function parseImport(node: Parser.SyntaxNode, file: string): ImportDecl | null {
  const source = node.children.find((c) => c.type === "string")?.text;
  if (!source) return null;
  const cleanSource = source.slice(1, -1);

  const importClause = node.children.find((c) => c.type === "import_clause");
  const names: string[] = [];
  let isDefault = false;

  if (importClause) {
    for (const child of importClause.children) {
      if (child.type === "identifier") {
        names.push(child.text);
        isDefault = true;
      } else if (child.type === "named_imports") {
        for (const spec of child.children) {
          if (spec.type === "import_specifier") {
            const name = spec.childForFieldName("name")?.text;
            if (name) names.push(name);
          }
        }
      }
    }
  }

  return { file, source: cleanSource, names, isDefault };
}
