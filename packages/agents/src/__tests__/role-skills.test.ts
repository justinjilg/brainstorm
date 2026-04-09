import { describe, it, expect } from "vitest";
import { ROLE_SKILLS, getSkillsForRole } from "../role-skills.js";

describe("ROLE_SKILLS", () => {
  const expectedRoles = [
    "architect",
    "coder",
    "reviewer",
    "debugger",
    "analyst",
    "orchestrator",
  ];

  it("has entries for all standard roles", () => {
    for (const role of expectedRoles) {
      expect(ROLE_SKILLS).toHaveProperty(role);
      expect(Array.isArray(ROLE_SKILLS[role as keyof typeof ROLE_SKILLS])).toBe(
        true,
      );
    }
  });

  it("each role has at least 3 skills", () => {
    for (const role of expectedRoles) {
      const skills = ROLE_SKILLS[role as keyof typeof ROLE_SKILLS];
      expect(skills.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("all skill names are lowercase kebab-case", () => {
    for (const [, skills] of Object.entries(ROLE_SKILLS)) {
      for (const skill of skills) {
        expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it("architect has planning skills", () => {
    const skills = ROLE_SKILLS.architect;
    expect(skills).toContain("planning-and-task-breakdown");
  });

  it("coder has implementation skills", () => {
    const skills = ROLE_SKILLS.coder;
    expect(skills).toContain("incremental-implementation");
    expect(skills).toContain("test-driven-development");
  });

  it("reviewer has review skills", () => {
    const skills = ROLE_SKILLS.reviewer;
    expect(skills).toContain("code-review-and-quality");
  });
});

describe("getSkillsForRole", () => {
  it("returns skills for a known role", () => {
    const skills = getSkillsForRole("architect");
    expect(skills.length).toBeGreaterThan(0);
    expect(skills).toContain("planning-and-task-breakdown");
  });

  it("returns empty array for unknown role", () => {
    const skills = getSkillsForRole("nonexistent" as any);
    expect(skills).toEqual([]);
  });
});
