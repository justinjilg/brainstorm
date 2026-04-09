import { test, expect } from "@playwright/test";
import {
  setupAllMocks,
  MOCK_TOOLS,
  MOCK_MEMORY,
  MOCK_SKILLS,
  MOCK_CONVERSATIONS,
  MOCK_SCORECARD,
} from "./fixtures/mocks";

test.describe("Data Flow — Mocked server data renders in UI", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  // ── Dashboard ──────────────────────────────────────────────────

  test("dashboard shows mocked tool count", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-dashboard").click();
    await expect(page.getByTestId("tool-count")).toContainText(
      String(MOCK_TOOLS.length),
    );
  });

  test("dashboard tool category expand shows tool names", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-dashboard").click();
    // Wait for tools to load
    await expect(page.getByTestId("tool-count")).toContainText(
      String(MOCK_TOOLS.length),
    );
    // Click the first tool category button
    const categories = page.locator("[data-testid^='tool-category-']");
    await expect(categories.first()).toBeVisible();
    await categories.first().click();
    // Tool names should appear in the expanded list
    await expect(page.locator("text=file_read")).toBeVisible();
  });

  // ── Memory ─────────────────────────────────────────────────────

  test("memory view shows mocked entries", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-memory").click();
    // Should show all 3 mock entries
    for (const entry of MOCK_MEMORY) {
      await expect(page.getByTestId(`memory-entry-${entry.id}`)).toBeVisible();
    }
  });

  test("memory tier filter actually filters", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-memory").click();
    // All 3 entries visible
    const entries = page.locator("[data-testid^='memory-entry-']");
    await expect(entries).toHaveCount(3);
    // Filter to system tier
    await page.getByTestId("tier-system").click();
    await expect(entries).toHaveCount(1);
    await expect(page.getByTestId("memory-entry-mem-1")).toBeVisible();
    // Filter to archive
    await page.getByTestId("tier-archive").click();
    await expect(entries).toHaveCount(1);
    await expect(page.getByTestId("memory-entry-mem-2")).toBeVisible();
    // Back to all
    await page.getByTestId("tier-all").click();
    await expect(entries).toHaveCount(3);
  });

  test("memory create calls POST", async ({ page }) => {
    let postCalled = false;
    await page.route("**/api/v1/memory", (route) => {
      if (route.request().method() === "POST") {
        postCalled = true;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"ok":true,"data":{"id":"mem-new"}}',
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: MOCK_MEMORY }),
        });
      }
    });
    await page.goto("/");
    await page.getByTestId("mode-memory").click();
    await page.getByTestId("new-entry").click();
    await page.locator("input[placeholder='Entry name']").fill("Test entry");
    await page
      .locator("textarea[placeholder='Content...']")
      .fill("Test content");
    await page.locator("button:has-text('Save')").click();
    expect(postCalled).toBe(true);
  });

  // ── Skills ─────────────────────────────────────────────────────

  test("skills view shows mocked skills", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-skills").click();
    for (const skill of MOCK_SKILLS) {
      await expect(page.getByTestId(`skill-row-${skill.name}`)).toBeVisible();
    }
  });

  test("skill toggle changes visual state", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-skills").click();
    const toggleBtn = page.getByTestId(`skill-toggle-${MOCK_SKILLS[0].name}`);
    await expect(toggleBtn).toBeVisible();
    // Click toggle — should become checked
    await toggleBtn.click();
    await expect(toggleBtn).toContainText("✓");
    // Click again — should uncheck
    await toggleBtn.click();
    await expect(toggleBtn).not.toContainText("✓");
  });

  // ── Conversations ──────────────────────────────────────────────

  test("conversation list shows mocked conversations", async ({ page }) => {
    await page.goto("/");
    // Wait for conversations to load from mock — may take a moment
    await expect(
      page.getByTestId(`conversation-${MOCK_CONVERSATIONS[0].id}`),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId(`conversation-${MOCK_CONVERSATIONS[1].id}`),
    ).toBeVisible();
  });

  test("new conversation calls POST and appears", async ({ page }) => {
    let postCalled = false;
    await page.route("**/api/v1/conversations", (route) => {
      if (route.request().method() === "POST") {
        postCalled = true;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              id: "conv-new",
              name: "New conversation",
              projectPath: "",
              tags: [],
              createdAt: new Date().toISOString(),
              lastMessageAt: new Date().toISOString(),
              isArchived: false,
            },
          }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: MOCK_CONVERSATIONS }),
        });
      }
    });
    await page.goto("/");
    await page.getByTestId("new-conversation").click();
    expect(postCalled).toBe(true);
    // New conversation should appear in sidebar
    await expect(page.getByTestId("conversation-conv-new")).toBeVisible();
  });

  // ── Chat ───────────────────────────────────────────────────────

  test("chat send calls streaming endpoint", async ({ page }) => {
    let streamCalled = false;
    await page.route("**/api/v1/chat/stream", (route) => {
      streamCalled = true;
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          "data: " +
          JSON.stringify({ type: "text-delta", delta: "Hi!" }) +
          "\ndata: [DONE]\n",
      });
    });
    await page.goto("/");
    await page.getByTestId("chat-input").fill("Hello!");
    await page.getByTestId("send-button").click();
    // Wait for the stream to be called
    await page.waitForTimeout(1000);
    expect(streamCalled).toBe(true);
  });

  // ── Security ───────────────────────────────────────────────────

  test("red team calls POST and shows scorecard", async ({ page }) => {
    let redTeamCalled = false;
    await page.route("**/api/v1/security/red-team", (route) => {
      redTeamCalled = true;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: MOCK_SCORECARD }),
      });
    });
    await page.goto("/");
    await page.getByTestId("mode-security").click();
    await page.getByTestId("run-red-team").click();
    // Wait for result
    await page.waitForTimeout(500);
    expect(redTeamCalled).toBe(true);
    // Scorecard should show the score
    await expect(page.locator("text=85%")).toBeVisible();
  });
});
