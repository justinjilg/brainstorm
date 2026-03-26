import type { AgentMiddleware, MiddlewareMessage } from "../types.js";
import { MemoryManager, type MemoryEntry } from "../../memory/manager.js";

type MemoryType = MemoryEntry["type"];

interface ExtractedFact {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
}

// Patterns that signal user preferences (type: feedback)
const PREFERENCE_PATTERNS: Array<{ pattern: RegExp; extract: string }> = [
  {
    pattern:
      /(?:always|never|prefer|don't|do not)\s+(use|add|include|create|write)\s+(.{5,60})/i,
    extract: "preference",
  },
  {
    pattern: /(?:I|we)\s+(?:always|never|prefer to)\s+(.{5,60})/i,
    extract: "preference",
  },
  {
    pattern: /(?:please|going forward|from now on),?\s+(.{5,60})/i,
    extract: "directive",
  },
];

// Patterns that signal project conventions (type: project)
const CONVENTION_PATTERNS: Array<{ pattern: RegExp; extract: string }> = [
  {
    pattern:
      /(?:this project|codebase|repo)\s+(?:uses|requires|follows|has)\s+(.{5,60})/i,
    extract: "convention",
  },
  {
    pattern: /(?:convention|pattern|standard)\s+(?:is|here is)\s+(.{5,60})/i,
    extract: "convention",
  },
  {
    pattern: /(?:configured|set up)\s+(?:with|to use|for)\s+(.{5,60})/i,
    extract: "setup",
  },
];

// Patterns that signal error-fix pairs (type: reference)
const ERROR_FIX_PATTERNS: Array<{ pattern: RegExp }> = [
  { pattern: /(?:fixed|resolved|solved)\s+(?:by|with|via)\s+(.{10,100})/i },
  {
    pattern: /(?:the (?:fix|solution|workaround))\s+(?:is|was)\s+(.{10,100})/i,
  },
  {
    pattern:
      /error[:\s]+(.{10,80}).*?(?:fix|solution|resolved)[:\s]+(.{10,80})/is,
  },
];

// Avoid extracting from these contexts (code blocks, tool calls, etc.)
const SKIP_PATTERNS = [
  /^```/m, // Inside code blocks
  /^\s*[-*]\s+\*\*/m, // Markdown list with bold (likely tool output)
];

// Deduplicate: skip facts we've already extracted this session
const extractedThisSession = new Set<string>();

/**
 * Create memory extraction middleware.
 * Scans assistant responses for extractable facts via regex heuristics (no LLM call).
 */
export function createMemoryExtractionMiddleware(
  projectPath: string,
): AgentMiddleware {
  let manager: MemoryManager | null = null;

  const getManager = (): MemoryManager => {
    if (!manager) manager = new MemoryManager(projectPath);
    return manager;
  };

  return {
    name: "memory-extraction",

    afterModel(message: MiddlewareMessage): void {
      const { text } = message;
      if (!text || text.length < 20) return;

      const facts = extractFacts(text);
      if (facts.length === 0) return;

      const mem = getManager();
      for (const fact of facts) {
        const key = `${fact.type}:${fact.name}`;
        if (extractedThisSession.has(key)) continue;
        extractedThisSession.add(key);

        mem.save({
          type: fact.type,
          name: fact.name,
          description: fact.description,
          content: fact.content,
        });
      }
    },
  };
}

function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Strip code blocks to avoid false positives
  const cleaned = text.replace(/```[\s\S]*?```/g, "");

  // Extract user preferences
  for (const { pattern } of PREFERENCE_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      const detail = (match[2] ?? match[1]).trim();
      if (detail.length >= 5 && detail.length <= 100) {
        facts.push({
          type: "feedback",
          name: `pref-${slugify(detail.slice(0, 30))}`,
          description: `User preference: ${detail.slice(0, 80)}`,
          content: detail,
        });
      }
    }
  }

  // Extract project conventions
  for (const { pattern } of CONVENTION_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      const detail = match[1].trim();
      if (detail.length >= 5 && detail.length <= 100) {
        facts.push({
          type: "project",
          name: `conv-${slugify(detail.slice(0, 30))}`,
          description: `Project convention: ${detail.slice(0, 80)}`,
          content: detail,
        });
      }
    }
  }

  // Extract error-fix pairs
  for (const { pattern } of ERROR_FIX_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      const detail = match[0].trim();
      if (detail.length >= 15) {
        facts.push({
          type: "reference",
          name: `fix-${slugify(detail.slice(0, 30))}`,
          description: `Error fix: ${detail.slice(0, 80)}`,
          content: detail,
        });
      }
    }
  }

  return facts;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}
