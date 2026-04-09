import type { Page } from "@playwright/test";

// ── Mock Data ────────────────────────────────────────────────────────

export const MOCK_HEALTH = {
  status: "healthy" as const,
  version: "1.2.0",
  uptime_seconds: 3600,
  god_mode: { connected: 5, tools: 12 },
  conversations: { active: 2 },
};

export const MOCK_TOOLS = [
  { name: "file_read", description: "Read a file", permission: "auto" },
  { name: "file_write", description: "Write a file", permission: "confirm" },
  { name: "file_edit", description: "Edit a file", permission: "confirm" },
  { name: "shell", description: "Run shell command", permission: "confirm" },
  {
    name: "gh_pr_create",
    description: "Create GitHub PR",
    permission: "confirm",
  },
  { name: "web_fetch", description: "Fetch a URL", permission: "auto" },
  {
    name: "br_recommend",
    description: "Get model recommendation",
    permission: "auto",
  },
];

export const MOCK_MEMORY = [
  {
    id: "mem-1",
    name: "User role preference",
    description: "User prefers architect role",
    type: "user",
    tier: "system",
    source: "conversation",
    trustScore: 0.95,
    content: "User is a senior engineer who prefers Opus for complex tasks.",
    contentHash: "abc123",
  },
  {
    id: "mem-2",
    name: "Project context",
    description: "Current project details",
    type: "project",
    tier: "archive",
    source: "auto-extracted",
    trustScore: 0.8,
    content: "Working on Brainstorm desktop app with Tauri 2 + React 19.",
    contentHash: "def456",
  },
  {
    id: "mem-3",
    name: "Quarantined entry",
    description: "Suspected injection",
    type: "reference",
    tier: "quarantine",
    source: "web_fetch",
    trustScore: 0.2,
    content: "This entry was flagged by the trust system.",
    contentHash: "ghi789",
  },
];

export const MOCK_SKILLS = [
  {
    name: "code-review-and-quality",
    description: "Code review best practices and quality checks",
    source: "builtin",
    content: "# Code Review\n\nReview code for bugs, style issues...",
  },
  {
    name: "incremental-implementation",
    description: "Build features incrementally with verification",
    source: "builtin",
    content: "# Incremental Implementation\n\nBuild in small steps...",
  },
  {
    name: "test-driven-development",
    description: "Write tests first, then implementation",
    source: "builtin",
    content: "# TDD\n\nRed-green-refactor cycle...",
  },
];

export const MOCK_CONVERSATIONS = [
  {
    id: "conv-1",
    name: "Debugging auth flow",
    projectPath: "/Users/test/project",
    tags: [],
    createdAt: "2026-04-07T10:00:00Z",
    lastMessageAt: "2026-04-07T12:30:00Z",
    isArchived: false,
  },
  {
    id: "conv-2",
    name: "Refactor API client",
    projectPath: "/Users/test/project",
    tags: ["refactor"],
    createdAt: "2026-04-06T15:00:00Z",
    lastMessageAt: "2026-04-06T16:45:00Z",
    isArchived: false,
  },
];

export const MOCK_SCORECARD = {
  overallScore: 0.85,
  categories: [
    {
      category: "prompt-injection",
      totalAttacks: 30,
      blocked: 28,
      evaded: 2,
      evasionRate: 0.067,
    },
    {
      category: "content-injection",
      totalAttacks: 30,
      blocked: 25,
      evaded: 5,
      evasionRate: 0.167,
    },
    {
      category: "tool-misuse",
      totalAttacks: 30,
      blocked: 30,
      evaded: 0,
      evasionRate: 0,
    },
  ],
  totalAttacksTested: 90,
  totalEvasions: 7,
  generations: 5,
  durationMs: 1234,
};

// ── SSE Helper ───────────────────────────────────────────────────────

export function buildSSEResponse(
  events: Array<Record<string, unknown>>,
): string {
  return events
    .map((e) => `data: ${JSON.stringify(e)}`)
    .concat(["data: [DONE]"])
    .join("\n");
}

export const MOCK_CHAT_STREAM = buildSSEResponse([
  { type: "session", sessionId: "sess-test-1" },
  {
    type: "routing",
    model: { name: "Claude Opus 4.6", provider: "anthropic" },
    strategy: "combined",
  },
  { type: "text-delta", delta: "Hello " },
  { type: "text-delta", delta: "from the " },
  { type: "text-delta", delta: "mock server!" },
  { type: "cost", totalCost: 0.0042 },
  { type: "done", totalCost: 0.0042 },
]);

// ── Route Helpers ────────────────────────────────────────────────────

function envelope<T>(data: T) {
  return JSON.stringify({ ok: true, data });
}

export async function setupAllMocks(page: Page) {
  await page.route("**/health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(MOCK_HEALTH),
    });
  });

  await page.route("**/api/v1/tools", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(MOCK_TOOLS),
    });
  });

  await page.route("**/api/v1/memory", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope(MOCK_MEMORY),
      });
    } else if (route.request().method() === "POST") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ id: "mem-new" }),
      });
    }
  });

  await page.route("**/api/v1/memory/*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });

  await page.route("**/api/v1/skills", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(MOCK_SKILLS),
    });
  });

  await page.route("**/api/v1/conversations**", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope(MOCK_CONVERSATIONS),
      });
    } else if (route.request().method() === "POST") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({
          id: "conv-new",
          name: "New conversation",
          projectPath: "",
          tags: [],
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          isArchived: false,
        }),
      });
    }
  });

  await page.route("**/api/v1/chat/stream", (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: MOCK_CHAT_STREAM,
    });
  });

  await page.route("**/api/v1/security/red-team", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(MOCK_SCORECARD),
    });
  });

  await page.route("**/api/v1/models", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope([]),
    });
  });
}

export async function setupServerDown(page: Page) {
  await page.route("**/health", (route) => route.abort("failed"));
  await page.route("**/api/v1/**", (route) => route.abort("failed"));
}

export async function setupServerError(page: Page) {
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":"Internal server error"}',
    }),
  );
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":"Internal server error"}',
    }),
  );
}
