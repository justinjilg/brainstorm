import { z } from 'zod';

/** Output schema for architect agents — structured implementation plan. */
export const implementationSpec = z.object({
  summary: z.string().describe('Brief summary of the implementation plan'),
  files: z.array(z.object({
    path: z.string().describe('File path'),
    action: z.enum(['create', 'modify', 'delete']).describe('What to do with this file'),
    description: z.string().describe('What changes to make'),
  })).describe('Files to create/modify/delete'),
  interfaces: z.array(z.string()).optional().describe('Key interfaces or types to define'),
  steps: z.array(z.string()).describe('Ordered implementation steps'),
  confidence: z.number().min(0).max(1).describe('Your confidence in this plan (0-1)'),
});

/** Output schema for coder agents — code changes produced. */
export const codeChanges = z.object({
  files: z.array(z.object({
    path: z.string().describe('File path'),
    content: z.string().describe('Full file content'),
    action: z.enum(['create', 'modify']).describe('Whether this is a new or modified file'),
  })).describe('Code files produced'),
  summary: z.string().describe('Brief description of what was implemented'),
  confidence: z.number().min(0).max(1).describe('Your confidence in this implementation (0-1)'),
});

/** Output schema for reviewer agents — review verdict. */
export const reviewResult = z.object({
  approved: z.boolean().describe('Whether the implementation is approved'),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'warning', 'suggestion']).describe('Issue severity'),
    file: z.string().optional().describe('File where the issue was found'),
    description: z.string().describe('Description of the issue'),
  })).describe('Issues found during review'),
  summary: z.string().describe('Overall review summary'),
  confidence: z.number().min(0).max(1).describe('Your confidence in this review (0-1)'),
});

/** Output schema for debugger agents — root cause analysis. */
export const debugResult = z.object({
  rootCause: z.string().describe('Root cause of the bug'),
  fix: z.string().describe('Recommended fix'),
  affectedFiles: z.array(z.string()).describe('Files that need changes'),
  reproductionSteps: z.array(z.string()).optional().describe('Steps to reproduce the bug'),
  confidence: z.number().min(0).max(1).describe('Your confidence in this diagnosis (0-1)'),
});

/** Registry of named schemas for use in workflow step definitions. */
export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  'implementation-spec': implementationSpec,
  'code-changes': codeChanges,
  'review-result': reviewResult,
  'debug-result': debugResult,
};

export function getOutputSchema(name: string): z.ZodType | undefined {
  return OUTPUT_SCHEMAS[name];
}
