/**
 * Tree-sitter based TypeScript parser.
 *
 * Extracts:
 *   - Function definitions (name, file, line, signature)
 *   - Class definitions (name, file, line, methods)
 *   - Method definitions (name, class, file, line)
 *   - Call sites (caller function, callee name, file, line)
 *   - Imports (file imports module)
 *
 * This is the foundation for the knowledge graph.
 */

import Parser from "tree-sitter";
// @ts-ignore - no type declarations
import TypeScript from "tree-sitter-typescript";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface FunctionDef {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: boolean;
  isAsync: boolean;
}

export interface ClassDef {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface MethodDef {
  name: string;
  className: string;
  file: string;
  startLine: number;
  endLine: number;
  isStatic: boolean;
  isAsync: boolean;
}

export interface CallSite {
  callerName: string | null; // null if at module level
  calleeName: string;
  file: string;
  line: number;
}

export interface ImportDecl {
  file: string;
  source: string; // the imported module path
  names: string[]; // imported names
  isDefault: boolean;
}

export interface ParsedFile {
  file: string;
  contentHash: string;
  functions: FunctionDef[];
  classes: ClassDef[];
  methods: MethodDef[];
  callSites: CallSite[];
  imports: ImportDecl[];
}

const parser = new Parser();
parser.setLanguage(TypeScript.typescript as any);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx as any);

/**
 * Parse a single TypeScript or TSX file and extract all structural info.
 */
export function parseFile(filePath: string): ParsedFile {
  const content = readFileSync(filePath, "utf-8");
  const contentHash = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);

  const useTsx = filePath.endsWith(".tsx");
  const p = useTsx ? tsxParser : parser;
  const tree = p.parse(content);

  const result: ParsedFile = {
    file: filePath,
    contentHash,
    functions: [],
    classes: [],
    methods: [],
    callSites: [],
    imports: [],
  };

  // Walk the tree and extract definitions + calls
  walk(tree.rootNode, result, null, null);

  return result;
}

function walk(
  node: Parser.SyntaxNode,
  result: ParsedFile,
  currentFunction: string | null,
  currentClass: string | null,
): void {
  switch (node.type) {
    case "function_declaration": {
      const name = getChildText(node, "name") ?? "<anonymous>";
      const isExported = node.parent?.type === "export_statement";
      const isAsync = hasChildType(node, "async");
      const signature = getSignature(node);
      result.functions.push({
        name,
        file: result.file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature,
        isExported,
        isAsync,
      });
      // Recurse with this as current function
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
      // Recurse with this as current class
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
      // Recurse — method body may contain calls; use "ClassName.method" as caller
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
      // Continue walking for nested calls
      break;
    }

    case "import_statement": {
      const imp = parseImport(node, result.file);
      if (imp) result.imports.push(imp);
      return;
    }

    case "arrow_function":
    case "function_expression": {
      // Arrow/function expressions can have a name if assigned to a variable
      let assignedName: string | null = null;
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        assignedName = getChildText(parent, "name");
      }
      if (assignedName) {
        result.functions.push({
          name: assignedName,
          file: result.file,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: getSignature(node),
          isExported: false, // hard to track accurately
          isAsync: hasChildType(node, "async"),
        });
      }
      for (const child of node.children) {
        walk(child, result, assignedName ?? currentFunction, currentClass);
      }
      return;
    }
  }

  // Default: recurse into children with unchanged context
  for (const child of node.children) {
    walk(child, result, currentFunction, currentClass);
  }
}

function getChildText(
  node: Parser.SyntaxNode,
  fieldName: string,
): string | null {
  const child = node.childForFieldName(fieldName);
  return child?.text ?? null;
}

function hasChildType(node: Parser.SyntaxNode, type: string): boolean {
  return node.children.some((c) => c.type === type);
}

function getSignature(node: Parser.SyntaxNode): string {
  // Get the first line up to the opening brace
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
  // call_expression has a "function" field that's the callee
  const fn = node.childForFieldName("function");
  if (!fn) return null;

  switch (fn.type) {
    case "identifier":
      return fn.text;
    case "member_expression": {
      // obj.method() → extract "method" as the call target
      // But also capture the full path for better resolution
      const property = fn.childForFieldName("property");
      return property?.text ?? null;
    }
    case "subscript_expression":
      return null; // dynamic, can't resolve statically
    default:
      return null;
  }
}

function parseImport(node: Parser.SyntaxNode, file: string): ImportDecl | null {
  // import_statement: "import" import_clause "from" string
  const source = node.children.find((c) => c.type === "string")?.text;
  if (!source) return null;
  const cleanSource = source.slice(1, -1); // strip quotes

  const importClause = node.children.find((c) => c.type === "import_clause");
  const names: string[] = [];
  let isDefault = false;

  if (importClause) {
    for (const child of importClause.children) {
      if (child.type === "identifier") {
        // Default import: import X from "..."
        names.push(child.text);
        isDefault = true;
      } else if (child.type === "named_imports") {
        // Named imports: import { A, B } from "..."
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
