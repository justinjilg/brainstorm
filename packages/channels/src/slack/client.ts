/**
 * SlackClient — thin wrapper over Slack Web API (chat.postMessage, chat.update,
 * apps.connections.open, auth.test). No retries except a single Retry-After
 * honor on HTTP 429. Errors surface Slack's `error` field.
 */

export interface SlackClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class SlackError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
  ) {
    super(`Slack API error (${method}): ${slackError}`);
    this.name = "SlackError";
  }
}

/** Cap how long we'll honor a Slack Retry-After hint before giving up. */
const MAX_RETRY_AFTER_SECONDS = 60;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  url?: string;
  user_id?: string;
  team_id?: string;
  [key: string]: unknown;
}

export class SlackClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly botToken: string,
    opts: SlackClientOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://slack.com/api";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    token: string = this.botToken,
    retried = false,
  ): Promise<SlackApiResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && !retried) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 1;
      if (
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > MAX_RETRY_AFTER_SECONDS
      ) {
        throw new SlackError(method, "rate_limited_too_long");
      }
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.call(method, body, token, true);
    }

    let json: SlackApiResponse;
    try {
      json = (await res.json()) as SlackApiResponse;
    } catch (err) {
      if (!res.ok) {
        throw new SlackError(method, `http_${res.status}`);
      }
      throw err;
    }

    if (!res.ok || !json.ok) {
      throw new SlackError(method, json.error ?? `http_${res.status}`);
    }

    return json;
  }

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string }> {
    const json = await this.call("chat.postMessage", {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return { ts: String(json.ts) };
  }

  async update(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text });
  }

  async connectionsOpen(appToken: string): Promise<{ url: string }> {
    const json = await this.call("apps.connections.open", {}, appToken);
    return { url: String(json.url) };
  }

  async authTest(): Promise<{ userId: string; teamId: string }> {
    const json = await this.call("auth.test", {});
    return { userId: String(json.user_id), teamId: String(json.team_id) };
  }
}
