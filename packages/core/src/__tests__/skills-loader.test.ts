import { describe, it, expect } from "vitest";
import { loadSkills, findSkill } from "../skills/loader";
import { buildRepoMap, repoMapToContext } from "../agent/repo-map";

/**
 * Skills loader and repo map tests.
 * Verifies skill loading, frontmatter parsing, and repo map generation.
 */

describe("loadSkills", () => {
  it("loads skills from project directory", () => {
    // This project has .claude/commands/ which are loaded as claude-compat skills
    const skills = loadSkills(process.cwd());

    // Should find some skills (at least from .claude/commands/ if they exist)
    expect(Array.isArray(skills)).toBe(true);
  });

  it("loads builtin skills even for nonexistent project", () => {
    const skills = loadSkills("/nonexistent/path");
    // Builtin skills always load regardless of project path
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.source === "builtin")).toBe(true);
  });

  it("skills have required fields", () => {
    const skills = loadSkills(process.cwd());

    for (const skill of skills) {
      expect(skill).toHaveProperty("name");
      expect(skill).toHaveProperty("description");
      expect(skill).toHaveProperty("content");
      expect(skill).toHaveProperty("source");
      expect(["project", "global", "claude-compat", "builtin"]).toContain(
        skill.source,
      );
    }
  });
});

describe("findSkill", () => {
  it("finds a skill by name", () => {
    const skills = loadSkills(process.cwd());
    if (skills.length > 0) {
      const found = findSkill(skills, skills[0].name);
      expect(found).toBeDefined();
      expect(found!.name).toBe(skills[0].name);
    }
  });

  it("returns undefined for missing skill", () => {
    const skills = loadSkills(process.cwd());
    const found = findSkill(skills, "nonexistent-skill-name");
    expect(found).toBeUndefined();
  });
});

describe("buildRepoMap", () => {
  it("builds a map of project files", () => {
    const map = buildRepoMap(process.cwd(), 10);

    expect(map.entries.length).toBeGreaterThan(0);
    expect(map.topFiles.length).toBeLessThanOrEqual(10);
    expect(map.totalFiles).toBeGreaterThan(0);
    expect(map.generated).toBeGreaterThan(0);
  });

  it("entries have required fields", () => {
    const map = buildRepoMap(process.cwd(), 5);

    for (const entry of map.entries.slice(0, 5)) {
      expect(entry).toHaveProperty("file");
      expect(entry).toHaveProperty("exports");
      expect(entry).toHaveProperty("imports");
      expect(entry).toHaveProperty("symbols");
      expect(entry).toHaveProperty("lineCount");
      expect(entry.lineCount).toBeGreaterThan(0);
    }
  });

  it("ranks index files higher", () => {
    const map = buildRepoMap(process.cwd(), 20);

    // Index files should appear in top files due to +2 ranking boost
    const indexInTop = map.topFiles.some((f) => f.includes("index."));
    expect(indexInTop).toBe(true);
  });

  it("caches results within TTL", () => {
    const map1 = buildRepoMap(process.cwd(), 10);
    const map2 = buildRepoMap(process.cwd(), 10);

    // Same object returned from cache
    expect(map1).toBe(map2);
    expect(map1.generated).toBe(map2.generated);
  });
});

describe("repoMapToContext", () => {
  it("formats repo map as context string", () => {
    const map = buildRepoMap(process.cwd(), 5);
    const context = repoMapToContext(map);

    expect(context).toContain("Project structure");
    expect(context).toContain("key files");
    expect(context.split("\n").length).toBeGreaterThan(1);
  });

  it("shows exports for files that have them", () => {
    const map = buildRepoMap(process.cwd(), 10);
    const context = repoMapToContext(map);

    // At least some files should show exports
    expect(context).toContain("exports");
  });

  it("returns empty string for empty map", () => {
    const emptyMap = {
      entries: [],
      edges: [],
      topFiles: [],
      totalFiles: 0,
      generated: Date.now(),
    };
    expect(repoMapToContext(emptyMap)).toBe("");
  });
});

describe("Style Learner", () => {
  it("detects coding style from project", async () => {
    const { learnStyle } = await import("../learning/style-learner");
    const style = learnStyle(process.cwd());

    expect(style).toHaveProperty("indentStyle");
    expect(style).toHaveProperty("quoteStyle");
    expect(style).toHaveProperty("semicolons");
    expect(style).toHaveProperty("namingConvention");
    expect(["tabs", "spaces-2", "spaces-4", "mixed"]).toContain(
      style.indentStyle,
    );
  });

  it("formatStyleContext returns formatted string", async () => {
    const { formatStyleContext } = await import("../learning/style-learner");
    const context = formatStyleContext(process.cwd());

    // Should detect some conventions
    if (context) {
      expect(context).toContain("- ");
    }
  });
});
