/**
 * Pre-validation — check file content before writing to disk.
 * Validates JSON and detects obvious syntax issues.
 * Returns warnings (does NOT block writes).
 */

import { extname } from 'node:path';

export interface PreValidationResult {
  ok: boolean;
  warnings: string[];
}

/** Validate content based on file extension. Non-blocking — returns warnings. */
export function preValidate(filePath: string, content: string): PreValidationResult {
  const ext = extname(filePath).toLowerCase();
  const warnings: string[] = [];

  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (e: any) {
      warnings.push(`JSON syntax error: ${e.message}`);
    }
  }

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
    // Quick heuristic checks (not a full parser, just obvious issues)
    const tsWarnings = checkBracketBalance(content);
    warnings.push(...tsWarnings);
  }

  if (ext === '.yaml' || ext === '.yml') {
    // Basic YAML check: indentation consistency
    const yamlWarnings = checkYamlBasics(content);
    warnings.push(...yamlWarnings);
  }

  return { ok: warnings.length === 0, warnings };
}

/** Check for mismatched brackets/braces/parens. */
function checkBracketBalance(content: string): string[] {
  const warnings: string[] = [];
  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set([')', ']', '}']);
  let inString = false;
  let stringChar = '';
  let escaped = false;
  let lineNum = 1;
  let inTemplateString = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === '\n') { lineNum++; continue; }

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    // Track string state
    if (!inString && !inTemplateString) {
      if (ch === "'" || ch === '"') { inString = true; stringChar = ch; continue; }
      if (ch === '`') { inTemplateString = true; continue; }
    } else if (inString && ch === stringChar) {
      inString = false; continue;
    } else if (inTemplateString && ch === '`') {
      inTemplateString = false; continue;
    }

    if (inString || inTemplateString) continue;

    // Skip single-line comments
    if (ch === '/' && i + 1 < content.length && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      lineNum++;
      continue;
    }

    if (pairs[ch]) {
      stack.push({ char: ch, line: lineNum });
    } else if (closers.has(ch)) {
      const expected = stack.length > 0 ? pairs[stack[stack.length - 1].char] : null;
      if (expected === ch) {
        stack.pop();
      } else {
        warnings.push(`Unexpected '${ch}' at line ${lineNum}`);
        return warnings; // Stop at first mismatch
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    warnings.push(`Unclosed '${unclosed.char}' from line ${unclosed.line}`);
  }

  return warnings;
}

/** Basic YAML validation. */
function checkYamlBasics(content: string): string[] {
  const warnings: string[] = [];
  const lines = content.split('\n');

  // Check for tabs (YAML doesn't allow tabs for indentation)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('\t')) {
      warnings.push(`Line ${i + 1}: YAML does not allow tab indentation`);
      break; // One warning is enough
    }
  }

  return warnings;
}
