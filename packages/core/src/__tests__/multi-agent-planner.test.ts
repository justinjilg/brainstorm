import { describe, it, expect } from "vitest";
import { parseDecomposition } from "../plan/multi-agent-planner.js";

describe("parseDecomposition", () => {
  it("parses plain JSON output", () => {
    const text = JSON.stringify({
      summary: "split work into 3 phases",
      subtasks: [
        {
          id: "search",
          description: "search the codebase",
          requiredCapabilities: ["tool-calling", "large-context"],
          complexity: "simple",
          dependsOn: [],
        },
      ],
    });
    const result = parseDecomposition(text);
    expect(result).not.toBeNull();
    expect(result?.summary).toBe("split work into 3 phases");
    expect(result?.subtasks).toHaveLength(1);
    expect(result?.subtasks[0]).toMatchObject({
      id: "search",
      description: "search the codebase",
      requiredCapabilities: ["tool-calling", "large-context"],
      complexity: "simple",
      dependsOn: [],
    });
  });

  it("parses JSON wrapped in fenced code blocks", () => {
    const text = `Here is the decomposition:

\`\`\`json
{
  "summary": "fix auth bugs",
  "subtasks": [
    {"id": "find", "description": "find auth files", "requiredCapabilities": ["tool-calling"], "complexity": "simple", "dependsOn": []},
    {"id": "fix", "description": "fix the bug", "requiredCapabilities": ["code-generation"], "complexity": "moderate", "dependsOn": ["find"]}
  ]
}
\`\`\`

Let me know if you need anything else.`;
    const result = parseDecomposition(text);
    expect(result).not.toBeNull();
    expect(result?.subtasks).toHaveLength(2);
    expect(result?.subtasks[1].dependsOn).toEqual(["find"]);
  });

  it("parses JSON with leading/trailing prose by brace matching", () => {
    const text = `Sure, here is the breakdown of what I plan to do:
{
  "summary": "two parallel tasks",
  "subtasks": [
    {"id": "a", "description": "task a", "dependsOn": []},
    {"id": "b", "description": "task b", "dependsOn": []}
  ]
}
That should cover everything.`;
    const result = parseDecomposition(text);
    expect(result).not.toBeNull();
    expect(result?.subtasks).toHaveLength(2);
    // Missing requiredCapabilities should default to []
    expect(result?.subtasks[0].requiredCapabilities).toEqual([]);
    expect(result?.subtasks[0].complexity).toBe("moderate");
  });

  it("returns null when there is no parseable JSON", () => {
    expect(
      parseDecomposition("just a sentence with no json at all"),
    ).toBeNull();
  });

  it("returns null when the JSON is not in the expected shape", () => {
    expect(parseDecomposition('{"foo": "bar"}')).toBeNull();
    expect(parseDecomposition("[1, 2, 3]")).toBeNull();
    expect(
      parseDecomposition('{"summary": "x", "subtasks": "not an array"}'),
    ).toBeNull();
  });

  it("filters out subtasks missing id or description", () => {
    const text = JSON.stringify({
      summary: "mixed validity",
      subtasks: [
        { id: "good", description: "valid task", dependsOn: [] },
        { description: "missing id" },
        { id: "missing-desc" },
        { id: "alsogood", description: "another valid", dependsOn: ["good"] },
      ],
    });
    const result = parseDecomposition(text);
    expect(result?.subtasks).toHaveLength(2);
    expect(result?.subtasks.map((s) => s.id)).toEqual(["good", "alsogood"]);
  });

  it("normalizes missing optional fields with sensible defaults", () => {
    const text = JSON.stringify({
      summary: "minimal",
      subtasks: [{ id: "x", description: "minimal task" }],
    });
    const result = parseDecomposition(text);
    expect(result?.subtasks[0]).toEqual({
      id: "x",
      description: "minimal task",
      requiredCapabilities: [],
      complexity: "moderate",
      dependsOn: [],
      estimatedTokens: undefined,
    });
  });
});
