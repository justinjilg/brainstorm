import { test, expect } from "@playwright/test";
import {
  setupAllMocks,
  MOCK_MEMORY,
  MOCK_SKILLS,
  MOCK_CONVERSATIONS,
  gotoPlace,
  openGrowthSkills,
  openSettings,
} from "./fixtures/mocks";

test.describe("Data Flow — mocked server data renders in the new shell", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  // ── Memory (Growth) ──────────────────────────────────────────────

  test("memory view shows mocked entries", async ({ page }) => {
    await page.goto("/");
    await gotoPlace(page, "growth");
    for (const entry of MOCK_MEMORY) {
      await expect(page.getByTestId(`memory-entry-${entry.id}`)).toBeVisible();
    }
  });

  test("memory tier filter actually filters", async ({ page }) => {
    await page.goto("/");
    await gotoPlace(page, "growth");
    const entries = page.locator("[data-testid^='memory-entry-']");
    await expect(entries).toHaveCount(3);
    await page.getByTestId("tier-system").click();
    await expect(entries).toHaveCount(1);
    await expect(page.getByTestId("memory-entry-mem-1")).toBeVisible();
    await page.getByTestId("tier-all").click();
    await expect(entries).toHaveCount(3);
  });

  // ── Skills (Growth) ──────────────────────────────────────────────

  test("skills view shows mocked skills", async ({ page }) => {
    await page.goto("/");
    await openGrowthSkills(page);
    for (const skill of MOCK_SKILLS) {
      await expect(page.getByTestId(`skill-row-${skill.name}`)).toBeVisible();
    }
  });

  test("skill toggle changes visual state", async ({ page }) => {
    await page.goto("/");
    await openGrowthSkills(page);
    const toggleBtn = page.getByTestId(`skill-toggle-${MOCK_SKILLS[0].name}`);
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
    await expect(toggleBtn).toContainText("✓");
    await toggleBtn.click();
    await expect(toggleBtn).not.toContainText("✓");
  });

  // ── Models (Settings drawer) ─────────────────────────────────────

  test("models table renders rows from the backend", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    const rows = page.locator("[data-testid^='model-row-']");
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
    await expect(await rows.count()).toBeGreaterThan(0);
  });

  // ── Conversations (Talk thread sidebar) ──────────────────────────

  test("thread sidebar shows mocked conversations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(MOCK_CONVERSATIONS[0].name)).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText(MOCK_CONVERSATIONS[1].name)).toBeVisible();
  });

  test("new thread calls POST", async ({ page }) => {
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
    await page.getByTestId("new-thread").click();
    await page.waitForTimeout(500);
    expect(postCalled).toBe(true);
  });

  // ── Chat streaming ───────────────────────────────────────────────

  test("chat send calls the streaming endpoint", async ({ page }) => {
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
    await page.waitForTimeout(1000);
    expect(streamCalled).toBe(true);
  });
});
