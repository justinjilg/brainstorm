import type { AgentProfile } from '@brainstorm/shared';
import { OUTPUT_SCHEMAS } from './schemas.js';

const ROLE_PROMPTS: Record<string, string> = {
  architect: `You are a software architect. Your job is to analyze requirements and produce a detailed implementation plan. Think about file structure, interfaces, data flow, and edge cases before any code is written. Be thorough but practical.`,

  coder: `You are a senior software developer. Your job is to implement code based on specifications. Write clean, idiomatic, well-structured code. Follow existing patterns in the codebase. Use the available tools to read existing files, understand the project structure, and write code.`,

  reviewer: `You are a code reviewer. Your job is to review implementations for correctness, security, performance, and adherence to the specification. Be specific about issues — reference exact files and lines. Approve if the implementation is solid, reject with actionable feedback if not.`,

  debugger: `You are a debugging specialist. Your job is to identify the root cause of bugs. Read error messages, trace execution paths, and isolate the issue. Provide a clear diagnosis and recommended fix.`,

  analyst: `You are a technical analyst. Your job is to explain code, architecture, and technical concepts clearly. Provide insightful explanations that help the developer understand the codebase better.`,

  orchestrator: `You are a workflow orchestrator. Your job is to coordinate multi-agent workflows: decide which agent runs next, check budget constraints, handle review rejections, manage retry loops, and ensure the workflow completes successfully. You do NOT write code yourself — you delegate to specialized agents and manage the process.`,
};

export function buildAgentSystemPrompt(agent: AgentProfile, stepDescription?: string): string {
  const parts: string[] = [];

  // Role-specific base prompt
  const rolePrompt = ROLE_PROMPTS[agent.role] ?? '';
  if (agent.systemPrompt) {
    parts.push(agent.systemPrompt);
  } else if (rolePrompt) {
    parts.push(rolePrompt);
  }

  // Agent description
  if (agent.description) {
    parts.push(`\nYour specific role: ${agent.description}`);
  }

  // Step description
  if (stepDescription) {
    parts.push(`\nCurrent task: ${stepDescription}`);
  }

  // Output format instructions — inject actual schema shape so the model knows the structure
  if (agent.outputFormat) {
    const schema = OUTPUT_SCHEMAS[agent.outputFormat];
    if (schema) {
      let schemaDesc: string;
      try {
        // Extract field names and types from Zod schema for human-readable description
        const shape = (schema as any)._def?.shape?.() ?? (schema as any).shape;
        if (shape) {
          const fields = Object.keys(shape).map((k) => {
            const field = shape[k];
            const desc = field?._def?.description ?? field?.description ?? '';
            return `  - ${k}: ${desc}`;
          });
          schemaDesc = `Required JSON fields:\n${fields.join('\n')}`;
        } else {
          schemaDesc = `Schema: ${agent.outputFormat}`;
        }
      } catch {
        schemaDesc = `Schema: ${agent.outputFormat}`;
      }
      parts.push(`\nYou MUST respond with valid JSON matching this structure. Include a "confidence" field (0.0 to 1.0) rating how confident you are in your output.\n\n${schemaDesc}`);
    }
  }

  // Guardrails
  if (agent.guardrails.pii) {
    parts.push(`\nIMPORTANT: Do NOT include any personally identifiable information (PII) in your output — no names, emails, phone numbers, addresses, or similar data. Use placeholders instead.`);
  }
  if (agent.guardrails.topicRestriction) {
    parts.push(`\nTopic restriction: ${agent.guardrails.topicRestriction}`);
  }

  return parts.join('\n');
}
