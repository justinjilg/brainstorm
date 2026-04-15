/**
 * GitHub Webhook Tools — create and manage webhooks.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { GitHubClient } from "../client.js";

export function createWebhookTools(
  client: GitHubClient,
  owner: string,
  repo: string,
): BrainstormToolDef[] {
  return [
    defineTool({
      name: "github_webhook_create",
      description: `Register a webhook on ${owner}/${repo} to receive push and PR events.`,
      permission: "confirm" as const,
      inputSchema: z.object({
        url: z
          .string()
          .describe(
            "Webhook delivery URL (e.g., https://your-server.com/api/v1/webhooks/github)",
          ),
        secret: z
          .string()
          .describe("Shared secret for HMAC signature verification"),
        events: z
          .array(z.string())
          .optional()
          .describe("Events to subscribe to (default: push, pull_request)"),
      }),
      async execute({ url, secret, events }) {
        const result = await client.createWebhook(
          owner,
          repo,
          url,
          secret,
          events,
        );
        return {
          id: result.id,
          url: result.config.url,
          events: result.events,
          active: result.active,
          createdAt: result.created_at,
        };
      },
    }),

    defineTool({
      name: "github_webhook_list",
      description: `List all webhooks configured on ${owner}/${repo}.`,
      permission: "auto" as const,
      inputSchema: z.object({}),
      async execute() {
        const hooks = await client.listWebhooks(owner, repo);
        return hooks.map((h: any) => ({
          id: h.id,
          url: h.config.url,
          events: h.events,
          active: h.active,
          lastResponse: h.last_response?.code,
        }));
      },
    }),
  ];
}
