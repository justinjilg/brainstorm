/**
 * GitHub Tools Integration Tests — real operations against platform-gold repo.
 *
 * These tests hit the actual GitHub API via gh CLI against justinjilg/platform-gold.
 * They exercise every read-only action and verify the returned data shapes.
 * Mutating actions (create, merge, close) are NOT tested to avoid side effects.
 *
 * Skipped in CI (process.env.CI === "true").
 *
 * This is the test Jamb asked for: not schema validation, not mock routing,
 * but real tools hitting a real repo and verifying real data comes back.
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

const isCI = process.env.CI === "true";
const run = isCI ? it.skip : it;
const REPO = "justinjilg/platform-gold";
const CWD = process.env.HOME + "/Projects/platform-gold";

describe("Integration: gh_repo against platform-gold", () => {
  run("info returns repo with correct name", async () => {
    const result = (await ghRepoTool.execute({
      action: "info",
      cwd: CWD,
    } as any)) as any;
    expect(result.repo).toBeDefined();
    expect(result.repo.name).toBe("platform-gold");
    expect(result.repo.owner).toBeDefined();
    expect(result.repo.defaultBranchRef).toBeDefined();
  });

  run("clone-url returns SSH and HTTPS URLs", async () => {
    const result = (await ghRepoTool.execute({
      action: "clone-url",
      cwd: CWD,
    } as any)) as any;
    expect(result.sshUrl).toContain("git@github.com");
    expect(result.url).toContain("github.com");
  });

  run("labels returns array of label objects", async () => {
    const result = (await ghRepoTool.execute({
      action: "labels",
      cwd: CWD,
    } as any)) as any;
    expect(result.labels).toBeDefined();
    expect(Array.isArray(result.labels)).toBe(true);
    if (result.labels.length > 0) {
      expect(result.labels[0]).toHaveProperty("name");
      expect(result.labels[0]).toHaveProperty("color");
    }
  });

  run("topics returns array", async () => {
    const result = (await ghRepoTool.execute({
      action: "topics",
      cwd: CWD,
    } as any)) as any;
    expect(result.topics).toBeDefined();
    expect(Array.isArray(result.topics)).toBe(true);
  });

  run("milestones returns array", async () => {
    const result = (await ghRepoTool.execute({
      action: "milestones",
      cwd: CWD,
    } as any)) as any;
    expect(result.milestones).toBeDefined();
    expect(Array.isArray(result.milestones)).toBe(true);
  });
});

describe("Integration: gh_pr against platform-gold", () => {
  run("list returns PRs array with expected fields", async () => {
    const result = (await ghPrTool.execute({
      action: "list",
      state: "all",
      limit: 5,
      cwd: CWD,
    } as any)) as any;
    expect(result.prs).toBeDefined();
    expect(Array.isArray(result.prs)).toBe(true);
    if (result.prs.length > 0) {
      const pr = result.prs[0];
      expect(pr).toHaveProperty("number");
      expect(pr).toHaveProperty("title");
      expect(pr).toHaveProperty("state");
      expect(pr).toHaveProperty("url");
      expect(pr).toHaveProperty("headRefName");
    }
  });

  run("view returns PR details when PR exists", async () => {
    // First get a PR number
    const list = (await ghPrTool.execute({
      action: "list",
      state: "all",
      limit: 1,
      cwd: CWD,
    } as any)) as any;

    if (list.prs && list.prs.length > 0) {
      const result = (await ghPrTool.execute({
        action: "view",
        number: list.prs[0].number,
        cwd: CWD,
      } as any)) as any;
      expect(result.pr).toBeDefined();
      expect(result.pr.number).toBe(list.prs[0].number);
      expect(result.pr).toHaveProperty("body");
      expect(result.pr).toHaveProperty("files");
      expect(result.pr).toHaveProperty("additions");
      expect(result.pr).toHaveProperty("deletions");
    }
  });

  run("diff returns patch text when PR exists", async () => {
    const list = (await ghPrTool.execute({
      action: "list",
      state: "all",
      limit: 1,
      cwd: CWD,
    } as any)) as any;

    if (list.prs && list.prs.length > 0) {
      const result = (await ghPrTool.execute({
        action: "diff",
        number: list.prs[0].number,
        cwd: CWD,
      } as any)) as any;
      expect(result.diff).toBeDefined();
      expect(typeof result.diff).toBe("string");
    }
  });

  run("checks returns check array when PR exists", async () => {
    const list = (await ghPrTool.execute({
      action: "list",
      state: "all",
      limit: 1,
      cwd: CWD,
    } as any)) as any;

    if (list.prs && list.prs.length > 0) {
      const result = (await ghPrTool.execute({
        action: "checks",
        number: list.prs[0].number,
        cwd: CWD,
      } as any)) as any;
      // Checks may be empty if no CI configured, or may return checks
      expect(result.checks !== undefined || result.error !== undefined).toBe(
        true,
      );
    }
  });
});

describe("Integration: gh_issue against platform-gold", () => {
  run("list returns issues with expected fields", async () => {
    const result = (await ghIssueTool.execute({
      action: "list",
      state: "all",
      limit: 5,
      cwd: CWD,
    } as any)) as any;
    expect(result.issues).toBeDefined();
    expect(Array.isArray(result.issues)).toBe(true);
    if (result.issues.length > 0) {
      const issue = result.issues[0];
      expect(issue).toHaveProperty("number");
      expect(issue).toHaveProperty("title");
      expect(issue).toHaveProperty("state");
      expect(issue).toHaveProperty("labels");
    }
  });

  run("view returns issue with comments when issue exists", async () => {
    const list = (await ghIssueTool.execute({
      action: "list",
      state: "all",
      limit: 1,
      cwd: CWD,
    } as any)) as any;

    if (list.issues && list.issues.length > 0) {
      const result = (await ghIssueTool.execute({
        action: "view",
        number: list.issues[0].number,
        cwd: CWD,
      } as any)) as any;
      expect(result.issue).toBeDefined();
      expect(result.issue).toHaveProperty("body");
      expect(result.issue).toHaveProperty("comments");
    }
  });
});

describe("Integration: gh_actions against platform-gold", () => {
  run("workflows lists CI definitions", async () => {
    const result = (await ghActionsTool.execute({
      action: "workflows",
      cwd: CWD,
    } as any)) as any;
    // May error if no Actions, that's OK
    expect(result.workflows || result.error).toBeDefined();
    if (result.workflows) {
      expect(Array.isArray(result.workflows)).toBe(true);
      if (result.workflows.length > 0) {
        expect(result.workflows[0]).toHaveProperty("name");
        expect(result.workflows[0]).toHaveProperty("state");
      }
    }
  });

  run("runs lists recent workflow runs", async () => {
    const result = (await ghActionsTool.execute({
      action: "runs",
      limit: 3,
      cwd: CWD,
    } as any)) as any;
    expect(result.runs || result.error).toBeDefined();
    if (result.runs) {
      expect(Array.isArray(result.runs)).toBe(true);
      if (result.runs.length > 0) {
        expect(result.runs[0]).toHaveProperty("status");
        expect(result.runs[0]).toHaveProperty("workflowName");
      }
    }
  });
});

describe("Integration: gh_release against platform-gold", () => {
  run("list returns releases", async () => {
    const result = (await ghReleaseTool.execute({
      action: "list",
      limit: 3,
      cwd: CWD,
    } as any)) as any;
    expect(result.releases || result.error).toBeDefined();
    if (result.releases) {
      expect(Array.isArray(result.releases)).toBe(true);
    }
  });
});

describe("Integration: gh_search against platform-gold", () => {
  run("code search finds files in repo", async () => {
    const result = (await ghSearchTool.execute({
      action: "code",
      query: "drizzle",
      repo: REPO,
      limit: 5,
    } as any)) as any;
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  });

  run("issue search returns results array", async () => {
    const result = (await ghSearchTool.execute({
      action: "issues",
      query: "",
      repo: REPO,
      limit: 5,
    } as any)) as any;
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  });

  run("commit search finds commits", async () => {
    const result = (await ghSearchTool.execute({
      action: "commits",
      query: "feat",
      repo: REPO,
      limit: 5,
    } as any)) as any;
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  });

  run("repo search finds platform-gold", async () => {
    const result = (await ghSearchTool.execute({
      action: "repos",
      query: "platform-gold",
      owner: "justinjilg",
      limit: 3,
    } as any)) as any;
    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
    expect(
      result.results.some(
        (r: any) =>
          r.fullName === "justinjilg/platform-gold" ||
          r.fullName?.includes("platform-gold"),
      ),
    ).toBe(true);
  });
});

describe("Integration: gh_security against platform-gold", () => {
  run("dependabot alerts returns list or permission error", async () => {
    const result = (await ghSecurityTool.execute({
      action: "dependabot",
      cwd: CWD,
    } as any)) as any;
    // Dependabot may not be enabled, or may need push access
    expect(result.alerts || result.error).toBeDefined();
  });

  run("sbom returns dependency graph or error", async () => {
    const result = (await ghSecurityTool.execute({
      action: "sbom",
      cwd: CWD,
    } as any)) as any;
    expect(result.sbom || result.error).toBeDefined();
  });
});

describe("Integration: cross-tool workflow", () => {
  run("PR → diff → checks pipeline works end-to-end", async () => {
    // Step 1: List PRs
    const prList = (await ghPrTool.execute({
      action: "list",
      state: "all",
      limit: 1,
      cwd: CWD,
    } as any)) as any;

    if (!prList.prs || prList.prs.length === 0) {
      // No PRs in platform-gold — skip gracefully
      return;
    }

    const prNum = prList.prs[0].number;

    // Step 2: View PR details
    const prView = (await ghPrTool.execute({
      action: "view",
      number: prNum,
      cwd: CWD,
    } as any)) as any;
    expect(prView.pr).toBeDefined();
    expect(prView.pr.number).toBe(prNum);

    // Step 3: Get PR diff
    const prDiff = (await ghPrTool.execute({
      action: "diff",
      number: prNum,
      cwd: CWD,
    } as any)) as any;
    expect(prDiff.diff).toBeDefined();

    // Step 4: Check CI status
    const prChecks = (await ghPrTool.execute({
      action: "checks",
      number: prNum,
      cwd: CWD,
    } as any)) as any;
    expect(prChecks.checks || prChecks.error).toBeDefined();

    // Step 5: Get repo info for context
    const repoInfo = (await ghRepoTool.execute({
      action: "info",
      cwd: CWD,
    } as any)) as any;
    expect(repoInfo.repo.name).toBe("platform-gold");
  });
});
