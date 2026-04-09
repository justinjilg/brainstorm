import { describe, it, expect } from "vitest";
import { PRESET_WORKFLOWS, getPresetWorkflow } from "../presets.js";

describe("PRESET_WORKFLOWS", () => {
  it("has at least 3 preset workflows", () => {
    expect(PRESET_WORKFLOWS.length).toBeGreaterThanOrEqual(3);
  });

  it("every preset has required fields", () => {
    for (const w of PRESET_WORKFLOWS) {
      expect(w.id).toBeDefined();
      expect(typeof w.id).toBe("string");
      expect(w.name).toBeDefined();
      expect(w.description).toBeDefined();
      expect(w.communicationMode).toBeDefined();
      expect(Array.isArray(w.steps)).toBe(true);
      expect(w.steps.length).toBeGreaterThan(0);
    }
  });

  it("every step has required fields", () => {
    for (const w of PRESET_WORKFLOWS) {
      for (const step of w.steps) {
        expect(step.id).toBeDefined();
        expect(step.agentRole).toBeDefined();
        expect(step.description).toBeDefined();
        expect(Array.isArray(step.inputArtifacts)).toBe(true);
        expect(typeof step.isReviewStep).toBe("boolean");
      }
    }
  });

  it("all preset IDs are unique", () => {
    const ids = PRESET_WORKFLOWS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("review steps have loopBackTo defined", () => {
    for (const w of PRESET_WORKFLOWS) {
      for (const step of w.steps) {
        if (step.isReviewStep) {
          expect(step.loopBackTo).toBeDefined();
          // loopBackTo must reference a valid step ID
          const validIds = w.steps.map((s) => s.id);
          expect(validIds).toContain(step.loopBackTo);
        }
      }
    }
  });

  it("inputArtifacts reference valid outputArtifacts from prior steps", () => {
    for (const w of PRESET_WORKFLOWS) {
      const availableArtifacts = new Set<string>();
      for (const step of w.steps) {
        // Check all inputs are available
        for (const input of step.inputArtifacts) {
          expect(availableArtifacts.has(input)).toBe(true);
        }
        // Add this step's output for future steps
        if (step.outputArtifact) {
          availableArtifacts.add(step.outputArtifact);
        }
      }
    }
  });

  it("implement-feature workflow has plan → code → review steps", () => {
    const wf = PRESET_WORKFLOWS.find((w) => w.id === "implement-feature");
    expect(wf).toBeDefined();
    const stepIds = wf!.steps.map((s) => s.id);
    expect(stepIds).toContain("plan");
    expect(stepIds).toContain("code");
    expect(stepIds).toContain("review");
  });
});

describe("getPresetWorkflow", () => {
  it("returns a workflow by ID", () => {
    const wf = getPresetWorkflow("implement-feature");
    expect(wf).toBeDefined();
    expect(wf!.id).toBe("implement-feature");
  });

  it("returns undefined for unknown ID", () => {
    expect(getPresetWorkflow("nonexistent")).toBeUndefined();
  });
});
