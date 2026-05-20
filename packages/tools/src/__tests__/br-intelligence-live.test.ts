import { describe, expect, it } from "vitest";
import {
  brBudgetTool,
  brHealthTool,
  brInsightsTool,
  brLeaderboardTool,
  brMemorySearchTool,
  brModelsTool,
  brStatusTool,
} from "../builtin/br-intelligence.js";

const LIVE_GATE = process.env.RUN_LIVE_BR === "1";
const COMMUNITY_KEY =
  "br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a";

function ensureKey() {
  process.env.BRAINSTORM_API_KEY ??= COMMUNITY_KEY;
}

function isErrorResult(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function communityRateLimited(value: unknown): boolean {
  return (
    process.env.BRAINSTORM_API_KEY === COMMUNITY_KEY &&
    isErrorResult(value) &&
    value.error.includes("429")
  );
}

function collectErrors(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.error === "string" ? [record.error] : [];
  return [
    ...own,
    ...Object.values(record).flatMap((entry) => collectErrors(entry)),
  ];
}

function expectObjectOrCommunityRateLimit(value: unknown, name: string) {
  if (communityRateLimited(value)) return;
  const nestedErrors = collectErrors(value);
  if (nestedErrors.length > 0) {
    const onlyCommunityRateLimits =
      process.env.BRAINSTORM_API_KEY === COMMUNITY_KEY &&
      nestedErrors.every((error) => error.includes("429"));
    expect(
      onlyCommunityRateLimits,
      `${name} returned nested errors: ${nestedErrors.join(" | ")}`,
    ).toBe(true);
    return;
  }
  expect(
    isErrorResult(value),
    `${name} returned ${JSON.stringify(value)}`,
  ).toBe(false);
  expect(typeof value, `${name} should return an object`).toBe("object");
  expect(value, `${name} should not be null`).not.toBeNull();
}

describe.skipIf(!LIVE_GATE)(
  "BR native tools live smoke (RUN_LIVE_BR=1)",
  () => {
    it("executes all read-only BR tools through the operator-facing tool layer", async () => {
      ensureKey();

      const health = await brHealthTool.execute({});
      expectObjectOrCommunityRateLimit(health, "br_health");

      const status = await brStatusTool.execute({});
      expectObjectOrCommunityRateLimit(status, "br_status");

      const budget = await brBudgetTool.execute({});
      expectObjectOrCommunityRateLimit(budget, "br_budget");

      const models = await brModelsTool.execute({});
      expectObjectOrCommunityRateLimit(models, "br_models");

      const leaderboard = await brLeaderboardTool.execute({ sort: "overall" });
      expectObjectOrCommunityRateLimit(leaderboard, "br_leaderboard");

      const insights = await brInsightsTool.execute({});
      expectObjectOrCommunityRateLimit(insights, "br_insights");

      const memory = await brMemorySearchTool.execute({
        query: "business harness live discovery smoke",
      });
      expectObjectOrCommunityRateLimit(memory, "br_memory_search");
    });
  },
);

describe("BR native tools live smoke - skip self-check", () => {
  it("documents the live-test gate", () => {
    if (!LIVE_GATE) {
      console.log(
        "[br-intelligence-live] skipped - set RUN_LIVE_BR=1 to execute native BR tools",
      );
    }
    expect(true).toBe(true);
  });
});
