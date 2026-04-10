/**
 * Code Graph Tools — structural code queries via the knowledge graph.
 *
 * These replace the need for agents to use grep + shell for questions like
 * "who calls this function?" Instead of parsing text output, agents get
 * structured results in milliseconds.
 *
 * Tools:
 *   code_callers    — who calls this function?
 *   code_callees    — what does this function call?
 *   code_definition — go to definition (function/class/method)
 *   code_impact     — transitive callers (what breaks if X changes?)
 *   code_stats      — graph stats (diagnostics)
 */

import { z } from "zod";
import { defineTool } from "../base.js";

export const codeCallersTool = defineTool({
  name: "code_callers",
  description:
    "Find all call sites of a function by name. Returns structured results " +
    "with caller function, file, and line. MUCH faster than grep for 'who calls X'. " +
    "Requires the project to be indexed (run onboard first).",
  permission: "auto",
  inputSchema: z.object({
    name: z.string().describe("The function name to find callers for"),
    limit: z.number().optional().describe("Max results to return (default 50)"),
  }),
  async execute() {
    return {
      error: "Code graph tool not wired. See createWiredCodeGraphTools().",
    };
  },
});

export const codeCalleesTool = defineTool({
  name: "code_callees",
  description:
    "Find all functions called by a given function. Returns what the function invokes. " +
    "Use this to understand dependencies of a function.",
  permission: "auto",
  inputSchema: z.object({
    caller: z.string().describe("The caller function name"),
    limit: z.number().optional(),
  }),
  async execute() {
    return {
      error: "Code graph tool not wired. See createWiredCodeGraphTools().",
    };
  },
});

export const codeDefinitionTool = defineTool({
  name: "code_definition",
  description:
    "Find where a function, class, or method is defined. Returns kind, file, and line. " +
    "Equivalent to 'go to definition' in an IDE.",
  permission: "auto",
  inputSchema: z.object({
    name: z.string().describe("The symbol name to find"),
  }),
  async execute() {
    return { error: "Code graph tool not wired." };
  },
});

export const codeImpactTool = defineTool({
  name: "code_impact",
  description:
    "Impact analysis: find all transitive callers of a function. Use this BEFORE " +
    "changing a function signature to understand what might break. Returns callers up to N depth.",
  permission: "auto",
  inputSchema: z.object({
    name: z.string().describe("The function name to analyze"),
    depth: z.number().optional().describe("Max transitive depth (default 3)"),
  }),
  async execute() {
    return { error: "Code graph tool not wired." };
  },
});

export const codeStatsTool = defineTool({
  name: "code_stats",
  description:
    "Get code graph statistics: file count, function count, class count, call edge count. " +
    "Use this to verify the graph is populated.",
  permission: "auto",
  inputSchema: z.object({}),
  async execute() {
    return { error: "Code graph tool not wired." };
  },
});

/**
 * Create wired versions of the code graph tools that actually query a CodeGraph instance.
 */
export function createWiredCodeGraphTools(graph: any) {
  return [
    defineTool({
      name: "code_callers",
      description: codeCallersTool.description,
      permission: "auto",
      inputSchema: codeCallersTool.inputSchema,
      async execute(input) {
        try {
          const callers = graph.findCallers(input.name, {
            limit: input.limit ?? 50,
          });
          return {
            count: callers.length,
            callers: callers.map((c: any) => ({
              caller: c.caller ?? "(module-level)",
              file: c.file.replace(process.cwd() + "/", ""),
              line: c.line,
            })),
          };
        } catch (e: any) {
          return { error: `Code graph query failed: ${e.message}` };
        }
      },
    }),
    defineTool({
      name: "code_callees",
      description: codeCalleesTool.description,
      permission: "auto",
      inputSchema: codeCalleesTool.inputSchema,
      async execute(input) {
        try {
          const callees = graph.findCallees(input.caller, {
            limit: input.limit ?? 50,
          });
          return {
            count: callees.length,
            callees: callees.map((c: any) => ({
              callee: c.callee,
              file: c.file.replace(process.cwd() + "/", ""),
              line: c.line,
            })),
          };
        } catch (e: any) {
          return { error: `Code graph query failed: ${e.message}` };
        }
      },
    }),
    defineTool({
      name: "code_definition",
      description: codeDefinitionTool.description,
      permission: "auto",
      inputSchema: codeDefinitionTool.inputSchema,
      async execute(input) {
        try {
          const defs = graph.findDefinition(input.name);
          return {
            count: defs.length,
            definitions: defs.map((d: any) => ({
              kind: d.kind,
              name: d.name,
              className: d.className,
              file: d.file.replace(process.cwd() + "/", ""),
              line: d.startLine,
              signature: d.signature,
            })),
          };
        } catch (e: any) {
          return { error: `Code graph query failed: ${e.message}` };
        }
      },
    }),
    defineTool({
      name: "code_impact",
      description: codeImpactTool.description,
      permission: "auto",
      inputSchema: codeImpactTool.inputSchema,
      async execute(input) {
        try {
          const impact = graph.impactAnalysis(input.name, input.depth ?? 3);
          return {
            count: impact.length,
            transitiveCallers: impact.map((i: any) => ({
              name: i.name,
              depth: i.depth,
              file: i.file.replace(process.cwd() + "/", ""),
            })),
          };
        } catch (e: any) {
          return { error: `Code graph query failed: ${e.message}` };
        }
      },
    }),
    defineTool({
      name: "code_stats",
      description: codeStatsTool.description,
      permission: "auto",
      inputSchema: codeStatsTool.inputSchema,
      async execute() {
        try {
          return graph.stats();
        } catch (e: any) {
          return { error: `Code graph query failed: ${e.message}` };
        }
      },
    }),
  ];
}
