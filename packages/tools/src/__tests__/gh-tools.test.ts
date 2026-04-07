/**
 * GitHub Tools — schema validation + action routing + live smoke tests.
 *
 * These tests verify:
 *   1. Every tool's Zod schema accepts valid inputs and rejects invalid ones
 *   2. Every action routes correctly (returns error for missing required fields, not a crash)
 *   3. Live smoke tests against the actual repo (require gh auth, skipped in CI)
 */

import { describe, it, expect } from "vitest";
import { ghPrTool } from "../builtin/gh-pr";
import { ghIssueTool } from "../builtin/gh-issue";
import { ghReviewTool } from "../builtin/gh-review";
import { ghActionsTool } from "../builtin/gh-actions";
import { ghReleaseTool } from "../builtin/gh-release";
import { ghSearchTool } from "../builtin/gh-search";
import { ghSecurityTool } from "../builtin/gh-security";
import { ghRepoTool } from "../builtin/gh-repo";

// ════════════════════════════════════════════════════════════════════
// Schema Validation — every tool parses valid input without throwing
// ════════════════════════════════════════════════════════════════════

describe("gh_pr schema", () => {
  const schema = ghPrTool.inputSchema;

  it("accepts all 10 actions", () => {
    const actions = [
      "create",
      "list",
      "view",
      "merge",
      "close",
      "reopen",
      "diff",
      "checks",
      "comment",
      "ready",
    ];
    for (const action of actions) {
      expect(() => schema.parse({ action })).not.toThrow();
    }
  });

  it("rejects unknown action", () => {
    expect(() => schema.parse({ action: "nope" })).toThrow();
  });

  it("accepts create with all fields", () => {
    expect(() =>
      schema.parse({
        action: "create",
        title: "feat: add thing",
        body: "## Summary\nDoes a thing.",
        base: "main",
        draft: true,
        reviewers: ["alice", "bob"],
        labels: ["feature"],
      }),
    ).not.toThrow();
  });

  it("accepts merge with strategy", () => {
    expect(() =>
      schema.parse({
        action: "merge",
        number: 42,
        mergeMethod: "squash",
        deleteAfterMerge: true,
      }),
    ).not.toThrow();
  });
});

describe("gh_issue schema", () => {
  const schema = ghIssueTool.inputSchema;

  it("accepts all 12 actions", () => {
    const actions = [
      "create",
      "list",
      "view",
      "comment",
      "close",
      "reopen",
      "edit",
      "label",
      "assign",
      "pin",
      "unpin",
      "transfer",
    ];
    for (const action of actions) {
      expect(() => schema.parse({ action })).not.toThrow();
    }
  });

  it("accepts close with reason", () => {
    expect(() =>
      schema.parse({
        action: "close",
        number: 10,
        reason: "not_planned",
        commentBody: "Won't fix — duplicate of #5",
      }),
    ).not.toThrow();
  });

  it("accepts transfer", () => {
    expect(() =>
      schema.parse({
        action: "transfer",
        number: 10,
        targetRepo: "org/other-repo",
      }),
    ).not.toThrow();
  });
});

describe("gh_review schema", () => {
  const schema = ghReviewTool.inputSchema;

  it("accepts all 6 actions", () => {
    const actions = [
      "list",
      "create",
      "approve",
      "request-changes",
      "comment",
      "view-comments",
    ];
    for (const action of actions) {
      expect(() => schema.parse({ action, number: 1 })).not.toThrow();
    }
  });

  it("accepts inline comment with path and line", () => {
    expect(() =>
      schema.parse({
        action: "comment",
        number: 42,
        path: "src/index.ts",
        line: 15,
        side: "RIGHT",
        commentBody: "This should use a const instead of let.",
      }),
    ).not.toThrow();
  });
});

describe("gh_actions schema", () => {
  const schema = ghActionsTool.inputSchema;

  it("accepts all 8 actions", () => {
    const actions = [
      "workflows",
      "runs",
      "view-run",
      "trigger",
      "cancel",
      "rerun",
      "logs",
      "artifacts",
    ];
    for (const action of actions) {
      expect(() => schema.parse({ action })).not.toThrow();
    }
  });

  it("accepts trigger with inputs", () => {
    expect(() =>
      schema.parse({
        action: "trigger",
        workflow: "ci.yml",
        ref: "main",
        inputs: { environment: "staging", debug: "true" },
      }),
    ).not.toThrow();
  });
});

describe("gh_release schema", () => {
  const schema = ghReleaseTool.inputSchema;

  it("accepts all 6 actions", () => {
    const actions = ["create", "list", "view", "delete", "upload", "download"];
    for (const action of actions) {
      expect(() => schema.parse({ action })).not.toThrow();
    }
  });

  it("accepts create with all options", () => {
    expect(() =>
      schema.parse({
        action: "create",
        tag: "v1.0.0",
        title: "Release 1.0.0",
        notes: "## What's new\n- Everything",
        target: "main",
        draft: false,
        prerelease: false,
        generateNotes: true,
        files: ["dist/app.zip"],
      }),
    ).not.toThrow();
  });
});

describe("gh_search schema", () => {
  const schema = ghSearchTool.inputSchema;

  it("accepts all 5 actions", () => {
    const actions = ["code", "issues", "commits", "repos", "prs"];
    for (const action of actions) {
      expect(() => schema.parse({ action, query: "test" })).not.toThrow();
    }
  });

  it("requires query", () => {
    expect(() => schema.parse({ action: "code" })).toThrow();
  });

  it("accepts full filter set", () => {
    expect(() =>
      schema.parse({
        action: "code",
        query: "handleAuth",
        repo: "org/app",
        language: "typescript",
        filename: "auth.ts",
        limit: 20,
        sort: "indexed",
        order: "desc",
      }),
    ).not.toThrow();
  });
});

describe("gh_security schema", () => {
  const schema = ghSecurityTool.inputSchema;

  it("accepts all 4 actions", () => {
    const actions = ["dependabot", "code-scanning", "secret-scanning", "sbom"];
    for (const action of actions) {
      expect(() => schema.parse({ action })).not.toThrow();
    }
  });

  it("accepts dismiss with reason", () => {
    expect(() =>
      schema.parse({
        action: "dependabot",
        subAction: "dismiss",
        alertNumber: 5,
        dismissReason: "tolerable_risk",
      }),
    ).not.toThrow();
  });
});

describe("gh_repo schema", () => {
  const schema = ghRepoTool.inputSchema;

  it("accepts all 8 actions", () => {
    const actions = [
      "info",
      "collaborators",
      "branch-protection",
      "topics",
      "labels",
      "milestones",
      "fork",
      "clone-url",
    ];
    for (const action of actions) {
      expect(() => schema.parse({ action })).not.toThrow();
    }
  });

  it("accepts cross-repo with repo flag", () => {
    expect(() =>
      schema.parse({
        action: "info",
        repo: "anthropics/claude-code",
      }),
    ).not.toThrow();
  });

  it("accepts label creation", () => {
    expect(() =>
      schema.parse({
        action: "labels",
        labelName: "priority:high",
        labelColor: "ff0000",
        labelDescription: "Urgent issues",
      }),
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// Action Routing — every action returns a proper error for missing
// required fields instead of crashing
// ════════════════════════════════════════════════════════════════════

describe("gh_pr action routing", () => {
  it("create requires title", async () => {
    const result = await ghPrTool.execute({
      action: "create",
      body: "test",
    } as any);
    expect((result as any).error).toContain("title");
  });

  it("create requires body", async () => {
    const result = await ghPrTool.execute({
      action: "create",
      title: "test",
    } as any);
    expect((result as any).error).toContain("body");
  });

  it("view requires number", async () => {
    const result = await ghPrTool.execute({ action: "view" } as any);
    expect((result as any).error).toContain("number");
  });

  it("merge requires number", async () => {
    const result = await ghPrTool.execute({ action: "merge" } as any);
    expect((result as any).error).toContain("number");
  });

  it("close requires number", async () => {
    const result = await ghPrTool.execute({ action: "close" } as any);
    expect((result as any).error).toContain("number");
  });

  it("diff requires number", async () => {
    const result = await ghPrTool.execute({ action: "diff" } as any);
    expect((result as any).error).toContain("number");
  });

  it("checks requires number", async () => {
    const result = await ghPrTool.execute({ action: "checks" } as any);
    expect((result as any).error).toContain("number");
  });

  it("comment requires number and body", async () => {
    const result = await ghPrTool.execute({ action: "comment" } as any);
    expect((result as any).error).toContain("number");

    const result2 = await ghPrTool.execute({
      action: "comment",
      number: 1,
    } as any);
    expect((result2 as any).error).toContain("commentBody");
  });

  it("ready requires number", async () => {
    const result = await ghPrTool.execute({ action: "ready" } as any);
    expect((result as any).error).toContain("number");
  });
});

describe("gh_issue action routing", () => {
  it("create requires title", async () => {
    const result = await ghIssueTool.execute({ action: "create" } as any);
    expect((result as any).error).toContain("title");
  });

  it("view requires number", async () => {
    const result = await ghIssueTool.execute({ action: "view" } as any);
    expect((result as any).error).toContain("number");
  });

  it("comment requires number and body", async () => {
    const result = await ghIssueTool.execute({ action: "comment" } as any);
    expect((result as any).error).toContain("number");
  });

  it("transfer requires number and targetRepo", async () => {
    const result = await ghIssueTool.execute({
      action: "transfer",
      number: 1,
    } as any);
    expect((result as any).error).toContain("targetRepo");
  });
});

describe("gh_review action routing", () => {
  it("request-changes requires body", async () => {
    const result = await ghReviewTool.execute({
      action: "request-changes",
      number: 1,
    } as any);
    expect((result as any).error).toContain("body");
  });

  it("comment requires commentBody", async () => {
    const result = await ghReviewTool.execute({
      action: "comment",
      number: 1,
    } as any);
    expect((result as any).error).toContain("commentBody");
  });
});

describe("gh_actions action routing", () => {
  it("trigger requires workflow", async () => {
    const result = await ghActionsTool.execute({ action: "trigger" } as any);
    expect((result as any).error).toContain("workflow");
  });

  it("cancel requires runId", async () => {
    const result = await ghActionsTool.execute({ action: "cancel" } as any);
    expect((result as any).error).toContain("runId");
  });

  it("logs requires runId", async () => {
    const result = await ghActionsTool.execute({ action: "logs" } as any);
    expect((result as any).error).toContain("runId");
  });
});

describe("gh_release action routing", () => {
  it("create requires tag", async () => {
    const result = await ghReleaseTool.execute({ action: "create" } as any);
    expect((result as any).error).toContain("tag");
  });

  it("upload requires tag and files", async () => {
    const result = await ghReleaseTool.execute({
      action: "upload",
      tag: "v1.0.0",
    } as any);
    expect((result as any).error).toContain("files");
  });
});

describe("gh_search action routing", () => {
  // gh_search always has query (required by schema), so routing
  // should not error — it will fail at the gh CLI level if not authed.
  // We just verify the schema enforcement.
  it("rejects missing query", () => {
    expect(() => ghSearchTool.inputSchema.parse({ action: "code" })).toThrow();
  });
});

describe("gh_security action routing", () => {
  it("dismiss requires alertNumber", async () => {
    const result = await ghSecurityTool.execute({
      action: "dependabot",
      subAction: "dismiss",
    } as any);
    expect((result as any).error).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Live Smoke Tests — run against actual repo (skip in CI)
// ════════════════════════════════════════════════════════════════════

const isCI = process.env.CI === "true";
const liveIt = isCI ? it.skip : it;

describe("live: gh_pr", () => {
  liveIt("list returns PRs or empty array", async () => {
    const result = await ghPrTool.execute({
      action: "list",
      state: "all",
      limit: 3,
    } as any);
    expect(result).toHaveProperty("prs");
    expect(Array.isArray((result as any).prs)).toBe(true);
  });
});

describe("live: gh_issue", () => {
  liveIt("list returns issues or empty array", async () => {
    const result = await ghIssueTool.execute({
      action: "list",
      state: "all",
      limit: 3,
    } as any);
    expect(result).toHaveProperty("issues");
    expect(Array.isArray((result as any).issues)).toBe(true);
  });
});

describe("live: gh_actions", () => {
  liveIt("workflows returns workflow list", async () => {
    const result = await ghActionsTool.execute({
      action: "workflows",
    } as any);
    // Either workflows array or error (if no Actions configured)
    expect((result as any).workflows || (result as any).error).toBeDefined();
  });

  liveIt("runs returns run list", async () => {
    const result = await ghActionsTool.execute({
      action: "runs",
      limit: 3,
    } as any);
    expect((result as any).runs || (result as any).error).toBeDefined();
  });
});

describe("live: gh_repo", () => {
  liveIt("info returns repo metadata", async () => {
    const result = await ghRepoTool.execute({ action: "info" } as any);
    expect(result).toHaveProperty("repo");
    expect((result as any).repo).toHaveProperty("name");
  });
});

describe("live: gh_search", () => {
  liveIt("code search returns results", async () => {
    const result = await ghSearchTool.execute({
      action: "code",
      query: "defineTool",
      repo: "justinjilg/brainstorm",
      limit: 3,
    } as any);
    expect(result).toHaveProperty("results");
  });
});

describe("live: gh_release", () => {
  liveIt("list returns releases or empty", async () => {
    const result = await ghReleaseTool.execute({
      action: "list",
      limit: 3,
    } as any);
    expect((result as any).releases || (result as any).error).toBeDefined();
  });
});
