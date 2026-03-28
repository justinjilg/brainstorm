/**
 * Expert Persona Engine — composable expert playbooks with model-specific tuning.
 *
 * Personas are 200+ line expert playbooks carrying domain expertise,
 * structured reasoning frameworks, output templates, and model-specific
 * adaptations. They compose with skills and project context.
 */

export interface PersonaFramework {
  name: string;
  description: string;
  content: string;
}

export interface ModelAdaptation {
  /** Regex pattern matching model IDs (e.g., /opus|o3|gemini.*pro/) */
  modelPattern: RegExp;
  /** Label for this tier */
  tier: "deep-thinker" | "balanced" | "fast" | "reasoning" | "vision";
  /** Prompt modifier injected after the base prompt */
  modifier: string;
}

export interface Persona {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** The core expert playbook (200+ lines of domain expertise) */
  basePrompt: string;
  /** Embedded reasoning frameworks (C4, OWASP, Given/When/Then, etc.) */
  frameworks: PersonaFramework[];
  /** Structured output template the persona should follow */
  outputTemplate?: string;
  /** Model-specific adaptations — prompt adjusts based on which model receives it */
  modelAdaptations: ModelAdaptation[];
  /** Default tools this persona should have access to */
  permissionMode: "auto" | "confirm" | "plan";
  /** Default output style */
  outputStyle: "concise" | "detailed" | "learning";
  /** Default routing strategy */
  routingStrategy: string;
}

// ── Model Tuning ─────────────────────────────────────────────────────

const DEEP_THINKER_MODIFIER = `
## Model Tuning: Deep Thinker

You are running on a high-capability model with a large context window.
- Take time to explore the codebase thoroughly before proposing changes
- Consider 3+ alternatives before recommending an approach
- Show your reasoning: trade-offs, risks, dependencies
- Use structured output (diagrams, tables, matrices) to organize complex analysis
- Don't rush — quality and thoroughness are more valuable than speed`;

const BALANCED_MODIFIER = `
## Model Tuning: Balanced

You are running on a balanced quality/speed model.
- Be thorough but efficient
- Explain key decisions briefly (1-2 sentences per decision)
- Use structured output when it adds clarity, skip when it doesn't
- Self-verify: run builds, check for errors before presenting`;

const FAST_MODIFIER = `
## Model Tuning: Fast

You are running on a speed-optimized model.
- Be concise. Skip explanations unless asked.
- Follow existing patterns exactly. Don't invent new ones.
- One clear solution, not three alternatives.
- Focus on getting the task done correctly and quickly.`;

const REASONING_MODIFIER = `
## Model Tuning: Reasoning Model

You are a reasoning model with internal chain-of-thought.
- Do NOT explain your reasoning step-by-step — reason internally.
- Give direct, confident answers.
- Skip "Let me think about this..." preambles.
- Your internal reasoning is extensive; your output should be concise.`;

const VISION_MODIFIER = `
## Model Tuning: Vision-Capable

You can analyze images, screenshots, and diagrams.
- If the user shares a screenshot or mockup, extract specific details
- When designing UI, you can reference visual layouts
- Describe visual elements precisely (positions, colors, spacing)`;

/** Default model adaptations applied to all personas */
export const DEFAULT_MODEL_ADAPTATIONS: ModelAdaptation[] = [
  {
    modelPattern: /opus|o3-(?!mini)|gemini.*pro|gpt-5/i,
    tier: "deep-thinker",
    modifier: DEEP_THINKER_MODIFIER,
  },
  {
    modelPattern: /sonnet|gpt-4\.1(?!-mini)|kimi|deepseek/i,
    tier: "balanced",
    modifier: BALANCED_MODIFIER,
  },
  {
    modelPattern: /haiku|mini|flash/i,
    tier: "fast",
    modifier: FAST_MODIFIER,
  },
  {
    modelPattern: /o3-mini|o1|r1|reasoning/i,
    tier: "reasoning",
    modifier: REASONING_MODIFIER,
  },
];

// ── Composition Engine ───────────────────────────────────────────────

/**
 * Compose a persona's full system prompt, tuned for the specific model.
 *
 * Assembly order:
 * 1. Base persona prompt (expert playbook)
 * 2. Model-specific tuning (deep-thinker / balanced / fast / reasoning)
 * 3. Relevant frameworks (based on token budget)
 * 4. Output template
 */
export function composePersonaPrompt(
  persona: Persona,
  modelId?: string,
  maxTokens = 4000,
): string {
  const parts: string[] = [];

  // 1. Base prompt (always included)
  parts.push(persona.basePrompt);

  // 2. Model-specific tuning
  if (modelId) {
    // Check persona-specific adaptations first, then defaults
    const allAdaptations = [
      ...persona.modelAdaptations,
      ...DEFAULT_MODEL_ADAPTATIONS,
    ];
    const match = allAdaptations.find((a) => a.modelPattern.test(modelId));
    if (match) {
      parts.push(match.modifier);
    }
  }

  // 3. Frameworks (fit within token budget)
  // Rough estimate: 4 chars per token
  const currentChars = parts.join("").length;
  const remainingChars = maxTokens * 4 - currentChars;

  if (remainingChars > 500 && persona.frameworks.length > 0) {
    parts.push("\n## Reference Frameworks\n");
    let usedChars = 0;
    for (const fw of persona.frameworks) {
      if (usedChars + fw.content.length > remainingChars - 200) break;
      parts.push(`### ${fw.name}\n${fw.content}\n`);
      usedChars += fw.content.length;
    }
  }

  // 4. Output template
  if (persona.outputTemplate) {
    parts.push(`\n## Expected Output Format\n\n${persona.outputTemplate}`);
  }

  return parts.join("\n");
}

// ── Registry ─────────────────────────────────────────────────────────

const registry = new Map<string, Persona>();

export function registerPersona(persona: Persona): void {
  registry.set(persona.id, persona);
}

export function getPersona(id: string): Persona | undefined {
  return registry.get(id);
}

export function listPersonas(): Persona[] {
  return Array.from(registry.values());
}
