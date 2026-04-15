/**
 * GitHub God Mode Connector — integrates private GitHub repos into Brainstorm.
 *
 * Follows the GodModeConnector pattern. Provides tools for repo management,
 * webhook configuration, PR review, and compliance. Auth via PAT or GitHub App.
 */

import type {
  GodModeConnector,
  ConnectorCapability,
  HealthResult,
} from "../../types.js";
import type { BrainstormToolDef } from "@brainst0rm/tools";
import { GitHubClient, type GitHubClientConfig } from "./client.js";
import { createRepoTools } from "./tools/repo.js";
import { createWebhookTools } from "./tools/webhook.js";
import { createPRReviewTools } from "./tools/pr-review.js";
import { buildGitHubPrompt } from "./prompt.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("github-connector");

export interface GitHubConnectorConfig {
  /** PAT or installation token. */
  token?: string;
  /** GitHub App private key (PEM). */
  appPrivateKey?: string;
  /** GitHub App ID. */
  appId?: string;
  /** Installation ID. */
  installationId?: string;
  /** Repository owner (org or user). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Optional code graph for blast radius in PR reviews. */
  graph?: any;
}

export class GitHubConnector implements GodModeConnector {
  name = "github";
  displayName = "GitHub";
  capabilities: ConnectorCapability[] = [
    "access-control",
    "compliance",
    "audit",
    "deployment",
  ];

  private client: GitHubClient;
  private owner: string;
  private repo: string;
  private graph: any;
  private cachedTools: BrainstormToolDef[] | null = null;

  constructor(config: GitHubConnectorConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.graph = config.graph ?? null;
    this.client = new GitHubClient({
      token: config.token,
      appPrivateKey: config.appPrivateKey,
      appId: config.appId,
      installationId: config.installationId,
    });
  }

  getTools(): BrainstormToolDef[] {
    if (!this.cachedTools) {
      this.cachedTools = [
        ...createRepoTools(this.client, this.owner, this.repo),
        ...createWebhookTools(this.client, this.owner, this.repo),
        ...createPRReviewTools({
          client: this.client,
          owner: this.owner,
          repo: this.repo,
          graph: this.graph,
        }),
      ];
    }
    return this.cachedTools;
  }

  async healthCheck(): Promise<HealthResult> {
    const result = await this.client.healthCheck();
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      message: result.ok
        ? `Authenticated as ${result.user} for ${this.owner}/${this.repo}`
        : "GitHub API unreachable or authentication failed",
    };
  }

  getPrompt(): string {
    return buildGitHubPrompt(this.owner, this.repo);
  }

  /** Get the underlying client for advanced operations (PR review, checks). */
  getClient(): GitHubClient {
    return this.client;
  }
}

/**
 * Create a GitHub connector from environment/vault credentials.
 */
export function createGitHubConnector(
  owner: string,
  repo: string,
  resolveKey?: (name: string) => string | null,
): GitHubConnector | null {
  const token = resolveKey?.("GITHUB_TOKEN") ?? process.env.GITHUB_TOKEN;
  const appKey =
    resolveKey?.("GITHUB_APP_PRIVATE_KEY") ??
    process.env.GITHUB_APP_PRIVATE_KEY;
  const appId = resolveKey?.("GITHUB_APP_ID") ?? process.env.GITHUB_APP_ID;
  const installId =
    resolveKey?.("GITHUB_INSTALLATION_ID") ??
    process.env.GITHUB_INSTALLATION_ID;

  if (!token && !appKey) {
    log.debug("No GitHub credentials found — connector disabled");
    return null;
  }

  return new GitHubConnector({
    token: token ?? undefined,
    appPrivateKey: appKey ?? undefined,
    appId: appId ?? undefined,
    installationId: installId ?? undefined,
    owner,
    repo,
  });
}
