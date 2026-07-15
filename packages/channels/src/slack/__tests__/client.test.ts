import { describe, expect, it, vi } from "vitest";
import { SlackClient, SlackError } from "../client.js";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("SlackClient", () => {
  it("postMessage happy path posts to chat.postMessage and returns ts", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer xoxb-test");
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          channel: "C123",
          text: "hello",
          thread_ts: "111.222",
        });
        return jsonResponse({ ok: true, ts: "999.111" });
      },
    );

    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.postMessage("C123", "hello", "111.222");
    expect(result).toEqual({ ts: "999.111" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws SlackError including the Slack error field when ok:false", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "channel_not_found" }),
    );
    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.postMessage("C123", "hello")).rejects.toMatchObject({
      slackError: "channel_not_found",
    });
    await expect(client.postMessage("C123", "hello")).rejects.toBeInstanceOf(
      SlackError,
    );
  });

  it("honors Retry-After once on HTTP 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { ok: false, error: "rate_limited" },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      return jsonResponse({ ok: true, ts: "1.1" });
    });

    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.postMessage("C123", "hi");
    expect(result).toEqual({ ts: "1.1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second time after a repeated 429", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: "rate_limited" },
        { status: 429, headers: { "retry-after": "0" } },
      ),
    );

    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.postMessage("C123", "hi")).rejects.toBeInstanceOf(
      SlackError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws instead of waiting when Retry-After exceeds the cap", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: "rate_limited" },
        { status: 429, headers: { "retry-after": "3600" } },
      ),
    );

    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.postMessage("C123", "hi")).rejects.toBeInstanceOf(
      SlackError,
    );
    // Never actually waits/retries for an hour — bails after the single check.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws a SlackError (not a raw parse error) on a non-JSON error response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );

    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.postMessage("C123", "hi")).rejects.toBeInstanceOf(
      SlackError,
    );
    await expect(client.postMessage("C123", "hi")).rejects.toMatchObject({
      slackError: "http_502",
    });
  });

  it("update calls chat.update", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://slack.com/api/chat.update");
      return jsonResponse({ ok: true });
    });
    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.update("C1", "1.1", "updated text");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("connectionsOpen uses the passed app token and returns url", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://slack.com/api/apps.connections.open");
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer xapp-test");
        return jsonResponse({ ok: true, url: "wss://example.com/socket" });
      },
    );
    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.connectionsOpen("xapp-test");
    expect(result).toEqual({ url: "wss://example.com/socket" });
  });

  it("authTest returns userId and teamId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, user_id: "U1", team_id: "T1" }),
    );
    const client = new SlackClient("xoxb-test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.authTest();
    expect(result).toEqual({ userId: "U1", teamId: "T1" });
  });
});
