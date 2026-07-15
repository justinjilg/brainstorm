import { z } from "zod";

/** Output schema for architect agents — structured implementation plan. */
export const implementationSpec = z.object({
  summary: z.string().describe("Brief summary of the implementation plan"),
  files: z
    .array(
      z.object({
        path: z.string().describe("File path"),
        action: z
          .enum(["create", "modify", "delete"])
          .describe("What to do with this file"),
        description: z.string().describe("What changes to make"),
      }),
    )
    .describe("Files to create/modify/delete"),
  interfaces: z
    .array(z.string())
    .optional()
    .describe("Key interfaces or types to define"),
  steps: z.array(z.string()).describe("Ordered implementation steps"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this plan (0-1)"),
});

/** Output schema for coder agents — code changes produced. */
export const codeChanges = z.object({
  files: z
    .array(
      z.object({
        path: z.string().describe("File path"),
        content: z.string().describe("Full file content"),
        action: z
          .enum(["create", "modify"])
          .describe("Whether this is a new or modified file"),
      }),
    )
    .describe("Code files produced"),
  summary: z.string().describe("Brief description of what was implemented"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this implementation (0-1)"),
});

/** Output schema for reviewer agents — review verdict. */
export const reviewResult = z.object({
  approved: z.boolean().describe("Whether the implementation is approved"),
  issues: z
    .array(
      z.object({
        severity: z
          .enum(["critical", "warning", "suggestion"])
          .describe("Issue severity"),
        file: z.string().optional().describe("File where the issue was found"),
        description: z.string().describe("Description of the issue"),
      }),
    )
    .describe("Issues found during review"),
  summary: z.string().describe("Overall review summary"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this review (0-1)"),
});

/** Output schema for debugger agents — root cause analysis. */
export const debugResult = z.object({
  rootCause: z.string().describe("Root cause of the bug"),
  fix: z.string().describe("Recommended fix"),
  affectedFiles: z.array(z.string()).describe("Files that need changes"),
  reproductionSteps: z
    .array(z.string())
    .optional()
    .describe("Steps to reproduce the bug"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this diagnosis (0-1)"),
});

/** Output schema for a single judge-panel verdict. Structured verdicts
 * replace regex scanning of reviewer prose — one judge emits exactly this.
 * Mirrors the Verdict shape in @brainst0rm/shared (judge-side fields only:
 * modelId/provider/cost are stamped by the panel runner, not the judge). */
export const verdict = z.object({
  pass: z.boolean().describe("Whether the artifact passes this judge's review"),
  score: z.number().min(0).max(1).optional().describe("Quality score 0-1"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this verdict (0-1)"),
  rationale: z.string().describe("Concise justification for the verdict"),
  findings: z
    .array(
      z.object({
        severity: z
          .enum(["critical", "high", "medium", "low"])
          .describe("Finding severity"),
        description: z.string().describe("Description of the finding"),
        file: z
          .string()
          .optional()
          .describe("File where the finding was located"),
        line: z.number().optional().describe("Line number of the finding"),
      }),
    )
    .describe("Findings surfaced during review"),
  criteriaResults: z
    .array(
      z.object({
        criterion: z.string().describe("The acceptance criterion evaluated"),
        pass: z.boolean().describe("Whether this criterion is satisfied"),
        evidence: z
          .string()
          .optional()
          .describe("Evidence for the criterion result"),
      }),
    )
    .optional()
    .describe("Per-criterion results for contract acceptance gates"),
});

/** Registry of named schemas for use in workflow step definitions. */
export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  "implementation-spec": implementationSpec,
  "code-changes": codeChanges,
  "review-result": reviewResult,
  "debug-result": debugResult,
  verdict: verdict,
};

export function getOutputSchema(name: string): z.ZodType | undefined {
  return OUTPUT_SCHEMAS[name];
}
