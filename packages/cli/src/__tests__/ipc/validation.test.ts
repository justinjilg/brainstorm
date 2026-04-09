/**
 * IPC Param Validation Tests
 *
 * Verifies that Zod schemas reject malformed params before
 * they reach business logic. Tests the schemas directly
 * (not through the full IPC handler) for speed.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-declare the schemas here rather than importing from handler
// (handler has side-effectful imports). This tests the schema shapes.
const MemoryCreateParams = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(["user", "feedback", "project", "reference"]).optional(),
  source: z.string().optional(),
});

const MemoryDeleteParams = z.object({
  id: z.string().min(1),
});

const ChatStreamParams = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  modelId: z.string().optional(),
  role: z.string().optional(),
  activeSkills: z.array(z.string()).optional(),
});

const ConversationsHandoffParams = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
});

const WorkflowRunParams = z.object({
  workflowId: z.string().min(1),
  request: z.string().min(1),
});

const SecurityRedteamParams = z.object({
  generations: z.number().int().positive().optional(),
  populationSize: z.number().int().positive().optional(),
});

describe("IPC Param Validation", () => {
  describe("memory.create", () => {
    it("accepts valid params", () => {
      const result = MemoryCreateParams.parse({
        name: "test-memory",
        content: "some content",
        type: "user",
      });
      expect(result.name).toBe("test-memory");
      expect(result.type).toBe("user");
    });

    it("rejects missing name", () => {
      expect(() => MemoryCreateParams.parse({ content: "x" })).toThrow();
    });

    it("rejects empty name", () => {
      expect(() =>
        MemoryCreateParams.parse({ name: "", content: "x" }),
      ).toThrow();
    });

    it("rejects invalid type enum", () => {
      expect(() =>
        MemoryCreateParams.parse({
          name: "x",
          content: "y",
          type: "invalid",
        }),
      ).toThrow();
    });

    it("rejects number where string expected", () => {
      expect(() =>
        MemoryCreateParams.parse({ name: 42, content: "x" }),
      ).toThrow();
    });
  });

  describe("memory.delete", () => {
    it("accepts valid id", () => {
      const result = MemoryDeleteParams.parse({ id: "mem-1" });
      expect(result.id).toBe("mem-1");
    });

    it("rejects numeric id", () => {
      expect(() => MemoryDeleteParams.parse({ id: 42 })).toThrow();
    });

    it("rejects missing id", () => {
      expect(() => MemoryDeleteParams.parse({})).toThrow();
    });
  });

  describe("chat.stream", () => {
    it("accepts minimal params", () => {
      const result = ChatStreamParams.parse({ message: "hello" });
      expect(result.message).toBe("hello");
      expect(result.activeSkills).toBeUndefined();
    });

    it("accepts full params", () => {
      const result = ChatStreamParams.parse({
        message: "hello",
        sessionId: "s-1",
        modelId: "claude-opus-4-6",
        role: "architect",
        activeSkills: ["code-review", "tdd"],
      });
      expect(result.activeSkills).toHaveLength(2);
    });

    it("rejects empty message", () => {
      expect(() => ChatStreamParams.parse({ message: "" })).toThrow();
    });

    it("rejects missing message", () => {
      expect(() => ChatStreamParams.parse({})).toThrow();
    });

    it("rejects non-array activeSkills", () => {
      expect(() =>
        ChatStreamParams.parse({
          message: "hi",
          activeSkills: "not-an-array",
        }),
      ).toThrow();
    });
  });

  describe("conversations.handoff", () => {
    it("accepts valid params", () => {
      const result = ConversationsHandoffParams.parse({
        id: "conv-1",
        modelId: "claude-opus-4-6",
      });
      expect(result.id).toBe("conv-1");
    });

    it("rejects missing modelId", () => {
      expect(() =>
        ConversationsHandoffParams.parse({ id: "conv-1" }),
      ).toThrow();
    });
  });

  describe("workflow.run", () => {
    it("accepts valid params", () => {
      const result = WorkflowRunParams.parse({
        workflowId: "code-review",
        request: "Review the auth module",
      });
      expect(result.workflowId).toBe("code-review");
    });

    it("rejects missing request", () => {
      expect(() =>
        WorkflowRunParams.parse({ workflowId: "code-review" }),
      ).toThrow();
    });
  });

  describe("security.redteam", () => {
    it("accepts empty params (all optional)", () => {
      const result = SecurityRedteamParams.parse({});
      expect(result.generations).toBeUndefined();
    });

    it("accepts valid numbers", () => {
      const result = SecurityRedteamParams.parse({
        generations: 10,
        populationSize: 50,
      });
      expect(result.generations).toBe(10);
    });

    it("rejects negative numbers", () => {
      expect(() => SecurityRedteamParams.parse({ generations: -1 })).toThrow();
    });

    it("rejects non-integer", () => {
      expect(() => SecurityRedteamParams.parse({ generations: 5.5 })).toThrow();
    });

    it("rejects string where number expected", () => {
      expect(() =>
        SecurityRedteamParams.parse({ generations: "10" }),
      ).toThrow();
    });
  });
});
