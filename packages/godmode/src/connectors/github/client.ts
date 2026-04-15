/**
 * GitHub REST API Client — handles PAT and GitHub App authentication.
 *
 * PAT mode: Bearer token in Authorization header.
 * App mode: Sign JWT with RS256 private key → exchange for installation token.
 *
 * Uses native fetch. No external HTTP libraries.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("github-client");

const GITHUB_API = "https://api.github.com";

export interface GitHubClientConfig {
  /** Personal access token (PAT mode). */
  token?: string;
  /** GitHub App private key PEM (App mode). */
  appPrivateKey?: string;
  /** GitHub App ID (App mode). */
  appId?: string;
  /** Installation ID for the org (App mode). */
  installationId?: string;
}

export class GitHubClient {
  private token: string | null;
  private installationToken: string | null = null;
  private installationTokenExpiresAt = 0;
  private config: GitHubClientConfig;

  constructor(config: GitHubClientConfig) {
    this.config = config;
    this.token = config.token ?? null;
  }

  /**
   * Make an authenticated GitHub API request.
   */
  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.resolveToken();
    const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  // ── Repo Operations ─────────────────────────────────────────────

  async getRepo(owner: string, repo: string) {
    return this.request("GET", `/repos/${owner}/${repo}`);
  }

  async listBranches(owner: string, repo: string) {
    return this.request("GET", `/repos/${owner}/${repo}/branches?per_page=30`);
  }

  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ) {
    return this.request(
      "GET",
      `/repos/${owner}/${repo}/compare/${base}...${head}`,
    );
  }

  async getContents(owner: string, repo: string, path: string, ref?: string) {
    const query = ref ? `?ref=${ref}` : "";
    return this.request(
      "GET",
      `/repos/${owner}/${repo}/contents/${path}${query}`,
    );
  }

  // ── Webhook Operations ──────────────────────────────────────────

  async createWebhook(
    owner: string,
    repo: string,
    url: string,
    secret: string,
    events = ["push", "pull_request"],
  ) {
    return this.request("POST", `/repos/${owner}/${repo}/hooks`, {
      name: "web",
      active: true,
      events,
      config: { url, content_type: "json", secret, insecure_ssl: "0" },
    });
  }

  async listWebhooks(owner: string, repo: string) {
    return this.request("GET", `/repos/${owner}/${repo}/hooks`);
  }

  async deleteWebhook(owner: string, repo: string, hookId: number) {
    return this.request("DELETE", `/repos/${owner}/${repo}/hooks/${hookId}`);
  }

  // ── PR Operations ───────────────────────────────────────────────

  async getPR(owner: string, repo: string, number: number) {
    return this.request("GET", `/repos/${owner}/${repo}/pulls/${number}`);
  }

  async getPRFiles(owner: string, repo: string, number: number) {
    return this.request(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    );
  }

  async createReview(
    owner: string,
    repo: string,
    number: number,
    body: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "COMMENT",
    comments?: Array<{ path: string; line: number; body: string }>,
  ) {
    return this.request(
      "POST",
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      {
        body,
        event,
        comments,
      },
    );
  }

  // ── Check Runs ──────────────────────────────────────────────────

  async createCheckRun(
    owner: string,
    repo: string,
    opts: {
      name: string;
      headSha: string;
      status: "queued" | "in_progress" | "completed";
      conclusion?: "success" | "failure" | "action_required" | "neutral";
      summary?: string;
      text?: string;
    },
  ) {
    return this.request("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: opts.name,
      head_sha: opts.headSha,
      status: opts.status,
      ...(opts.conclusion ? { conclusion: opts.conclusion } : {}),
      output: opts.summary
        ? {
            title: opts.name,
            summary: opts.summary,
            text: opts.text,
          }
        : undefined,
    });
  }

  // ── Health ──────────────────────────────────────────────────────

  async healthCheck(): Promise<{
    ok: boolean;
    latencyMs: number;
    user?: string;
  }> {
    const start = Date.now();
    try {
      const user = await this.request<{ login: string }>("GET", "/user");
      return { ok: true, latencyMs: Date.now() - start, user: user.login };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // ── Token Resolution ────────────────────────────────────────────

  private async resolveToken(): Promise<string> {
    if (this.token) return this.token;

    // GitHub App mode — exchange app JWT for installation token
    if (
      this.config.appPrivateKey &&
      this.config.appId &&
      this.config.installationId
    ) {
      if (
        this.installationToken &&
        Date.now() < this.installationTokenExpiresAt
      ) {
        return this.installationToken;
      }
      this.installationToken = await this.exchangeForInstallationToken();
      this.installationTokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 min (tokens last 60)
      return this.installationToken;
    }

    throw new Error(
      "No GitHub authentication configured. Set GITHUB_TOKEN or configure GitHub App.",
    );
  }

  private async exchangeForInstallationToken(): Promise<string> {
    // Sign JWT with the app's private key using node:crypto RS256
    const appJwt = await this.createAppJwt();

    const res = await fetch(
      `${GITHUB_API}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!res.ok) {
      throw new Error(`GitHub App token exchange failed: ${res.status}`);
    }

    const data = (await res.json()) as { token: string };
    log.info("GitHub App installation token acquired");
    return data.token;
  }

  private async createAppJwt(): Promise<string> {
    // RS256 JWT for GitHub App authentication
    // Payload: iss=appId, iat=now-60, exp=now+600
    const { createPrivateKey, sign } = await import("node:crypto");

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.config.appId,
        iat: now - 60,
        exp: now + 600,
      }),
    ).toString("base64url");

    const key = createPrivateKey(this.config.appPrivateKey!);
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      key,
    ).toString("base64url");

    return `${header}.${payload}.${signature}`;
  }
}
