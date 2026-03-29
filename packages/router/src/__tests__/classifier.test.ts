import { describe, it, expect } from "vitest";
import { classifyTask } from "../classifier";
import type { TaskType } from "@brainstorm/shared";

describe("classifyTask", () => {
  describe("code-generation tasks", () => {
    it('should classify "create a new component" as code-generation', () => {
      const result = classifyTask("create a new component for the dashboard");
      expect(result.type).toBe("code-generation");
    });

    it('should classify "implement the API endpoint" as code-generation', () => {
      const result = classifyTask(
        "implement the API endpoint for user authentication",
      );
      expect(result.type).toBe("code-generation");
    });

    it('should classify "build a new feature" as code-generation', () => {
      const result = classifyTask("build a new feature to export data to CSV");
      expect(result.type).toBe("code-generation");
    });

    it('should classify "generate a scaffold" as code-generation', () => {
      const result = classifyTask("generate a scaffold for a REST API");
      expect(result.type).toBe("code-generation");
    });
  });

  describe("debugging tasks", () => {
    it('should classify "fix the bug" as debugging', () => {
      const result = classifyTask("fix the bug where users cannot log in");
      expect(result.type).toBe("debugging");
    });

    it('should classify "error in the code" as debugging', () => {
      const result = classifyTask(
        "there is an error in the code that crashes the app",
      );
      expect(result.type).toBe("debugging");
    });

    it('should classify "not working correctly" as debugging', () => {
      const result = classifyTask(
        "the search feature is not working correctly",
      );
      expect(result.type).toBe("debugging");
    });

    it('should classify "application is broken" as debugging', () => {
      const result = classifyTask(
        "the application is broken after the last deployment",
      );
      expect(result.type).toBe("debugging");
    });
  });

  describe("requiresToolUse flag", () => {
    it("should set requiresToolUse=true for code-generation tasks", () => {
      const result = classifyTask("create a new React component");
      expect(result.type).toBe("code-generation");
      expect(result.requiresToolUse).toBe(true);
    });

    it("should set requiresToolUse=true for debugging tasks", () => {
      const result = classifyTask("fix the broken authentication flow");
      expect(result.type).toBe("debugging");
      expect(result.requiresToolUse).toBe(true);
    });

    it("should set requiresToolUse=true for refactoring tasks", () => {
      const result = classifyTask(
        "refactor the user service to use dependency injection",
      );
      expect(result.type).toBe("refactoring");
      expect(result.requiresToolUse).toBe(true);
    });

    it("should set requiresToolUse=true for search tasks", () => {
      const result = classifyTask("find where the user model is defined");
      expect(result.type).toBe("search");
      expect(result.requiresToolUse).toBe(true);
    });

    it("should set requiresToolUse=false for conversation tasks", () => {
      const result = classifyTask("hello, can you help me with my project?");
      expect(result.type).toBe("conversation");
      expect(result.requiresToolUse).toBe(false);
    });

    it("should set requiresToolUse=false for explanation tasks without tool signals", () => {
      const result = classifyTask("explain how React hooks work");
      expect(result.type).toBe("explanation");
      expect(result.requiresToolUse).toBe(false);
    });

    it("should set requiresToolUse=false for analysis tasks without tool signals", () => {
      const result = classifyTask(
        "compare the pros and cons of TypeScript vs JavaScript",
      );
      expect(result.type).toBe("analysis");
      expect(result.requiresToolUse).toBe(false);
    });
  });

  describe("TOOL_USE_SIGNALS override", () => {
    it('should set requiresToolUse=true for explanation with "read the file" signal', () => {
      const result = classifyTask(
        "explain this function - read the file src/utils.ts",
      );
      expect(result.type).toBe("explanation");
      expect(result.requiresToolUse).toBe(true);
    });

    it('should set requiresToolUse=true for conversation with "open the file" signal', () => {
      const result = classifyTask(
        "can you open the file and tell me what it does?",
      );
      expect(result.type).toBe("conversation");
      expect(result.requiresToolUse).toBe(true);
    });

    it('should set requiresToolUse=true with "show me the code" signal', () => {
      const result = classifyTask(
        "show me the code for the user authentication",
      );
      expect(result.requiresToolUse).toBe(true);
    });

    it('should set requiresToolUse=true with "look at" signal', () => {
      const result = classifyTask(
        "look at the main.ts file and tell me what you think",
      );
      expect(result.requiresToolUse).toBe(true);
    });

    it('should set requiresToolUse=true with "run the" signal', () => {
      const result = classifyTask("run the tests and see if they pass");
      expect(result.requiresToolUse).toBe(true);
    });

    it('should set requiresToolUse=true with "create a file" signal', () => {
      const result = classifyTask("can you create a file named config.json?");
      expect(result.requiresToolUse).toBe(true);
    });

    it('should set requiresToolUse=true with "edit the file" signal', () => {
      const result = classifyTask(
        "edit the file to add a new import statement",
      );
      expect(result.requiresToolUse).toBe(true);
    });
  });

  describe("complexity detection", () => {
    it("should classify short messages as trivial or simple", () => {
      const result = classifyTask("add a comment");
      expect(["trivial", "simple"]).toContain(result.complexity);
    });

    it('should classify messages with "complex" keyword as complex', () => {
      const result = classifyTask("this is a complex refactoring task");
      expect(result.complexity).toBe("complex");
    });

    it("should classify long messages as more complex", () => {
      const longMessage =
        "implement a comprehensive user authentication system with JWT tokens, refresh tokens, role-based access control, multi-factor authentication, password reset flows, email verification, OAuth integration with Google and GitHub, session management, and audit logging".repeat(
          2,
        );
      const result = classifyTask(longMessage);
      expect(["moderate", "complex", "expert"]).toContain(result.complexity);
    });

    it("should consider fileCount context for complexity", () => {
      const result = classifyTask("update the components", { fileCount: 10 });
      expect(result.complexity).toBe("complex");
    });
  });

  describe("task type detection", () => {
    it("should classify simple-edit tasks", () => {
      const result = classifyTask('change the title to "Dashboard"');
      expect(result.type).toBe("simple-edit");
    });

    it("should classify refactoring tasks", () => {
      const result = classifyTask("refactor the code to use async/await");
      expect(result.type).toBe("refactoring");
    });

    it("should classify search tasks", () => {
      const result = classifyTask("search for where the API key is used");
      expect(result.type).toBe("search");
    });

    it("should classify multi-file-edit tasks", () => {
      const result = classifyTask(
        "changes needed across all files in the codebase",
      );
      expect(result.type).toBe("multi-file-edit");
    });

    it("should classify analysis tasks", () => {
      const result = classifyTask(
        "review the code and check for potential issues",
      );
      expect(result.type).toBe("analysis");
    });
  });

  describe("project hints", () => {
    it("should boost primary_tasks from project hints", () => {
      const result = classifyTask("restructure the code", undefined, {
        primary_tasks: ["refactoring"],
      } as any);
      // 'restructure' is a refactoring signal, boosted by hints
      expect(result.type).toBe("refactoring");
    });

    it("should use typical_complexity from project hints as fallback", () => {
      const result = classifyTask("do something", undefined, {
        typical_complexity: "expert",
      } as any);
      expect(result.complexity).toBe("expert");
    });
  });

  describe("language and domain detection", () => {
    it("should detect TypeScript language", () => {
      const result = classifyTask("create a new TypeScript component");
      expect(result.language).toBe("typescript");
    });

    it("should detect Python language", () => {
      const result = classifyTask("write a Python script using Flask");
      expect(result.language).toBe("python");
    });

    it("should detect frontend domain", () => {
      const result = classifyTask("build a React component for the UI");
      expect(result.domain).toBe("frontend");
    });

    it("should detect backend domain", () => {
      const result = classifyTask("implement the API endpoint on the server");
      expect(result.domain).toBe("backend");
    });

    it("should detect devops domain", () => {
      const result = classifyTask(
        "update the Docker configuration for deployment",
      );
      expect(result.domain).toBe("devops");
    });
  });

  describe("token estimation", () => {
    it("should estimate tokens for input and output", () => {
      const result = classifyTask("create a simple component");
      expect(result.estimatedTokens.input).toBeGreaterThan(0);
      expect(result.estimatedTokens.output).toBeGreaterThan(0);
    });

    it("should estimate more output tokens for code-generation than conversation", () => {
      const codeGen = classifyTask("create a new React component");
      const conversation = classifyTask("hello, how are you?");
      expect(codeGen.estimatedTokens.output).toBeGreaterThan(
        conversation.estimatedTokens.output,
      );
    });

    it("should estimate more tokens for complex tasks", () => {
      const simple = classifyTask("add a comment", { fileCount: 1 });
      const complex = classifyTask(
        "implement a complex authentication system",
        { fileCount: 10 },
      );
      expect(complex.estimatedTokens.output).toBeGreaterThan(
        simple.estimatedTokens.output,
      );
    });
  });

  describe("reasoning requirement", () => {
    it("should require reasoning for debugging tasks", () => {
      const result = classifyTask("fix the bug in the authentication flow");
      expect(result.requiresReasoning).toBe(true);
    });

    it("should require reasoning for complex tasks", () => {
      const result = classifyTask(
        "this is a complex task that needs careful thought",
      );
      expect(result.requiresReasoning).toBe(true);
    });

    it("should require reasoning for analysis tasks", () => {
      const result = classifyTask(
        "analyze the codebase for security vulnerabilities",
      );
      expect(result.requiresReasoning).toBe(true);
    });

    it("should not require reasoning for simple conversation tasks", () => {
      const result = classifyTask("hello there");
      expect(result.requiresReasoning).toBe(false);
    });
  });
});
