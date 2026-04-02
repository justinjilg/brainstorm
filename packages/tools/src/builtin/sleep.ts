/**
 * SleepTool — gives the daemon model temporal agency.
 *
 * Instead of waking on a fixed interval, the model can choose
 * how long to sleep and explain why. The daemon controller
 * interprets the result and schedules the next tick accordingly.
 *
 * ⚠️ Prompt cache warning: Anthropic's prompt cache expires after ~5 minutes.
 * Sleeping longer than that means the next tick pays full input token cost.
 * The description below tells the model about this trade-off.
 */

import { z } from "zod";
import { defineTool } from "../base.js";

export const daemonSleepTool = defineTool({
  name: "daemon_sleep",
  description: `Put the daemon to sleep for a specified duration.

Use this when there's nothing to do right now. The daemon will wake after the specified time (or earlier if the user sends input or a scheduled task fires).

**Cost trade-off:** Prompt cache expires after ~5 minutes of inactivity. Sleeping ≤ 4 minutes keeps the cache warm (cheap next tick). Sleeping > 5 minutes invalidates the cache (expensive next tick). Choose wisely:
- Short sleep (30-240s): Use when you expect activity soon or want to monitor something.
- Medium sleep (240-300s): Maximum sleep that preserves prompt cache.
- Long sleep (300-3600s): Use when truly idle. Saves API calls but next tick costs more tokens.

If you don't call this tool, the daemon uses its default tick interval.`,
  permission: "auto",
  concurrent: false,
  readonly: true,
  inputSchema: z.object({
    seconds: z
      .number()
      .min(5)
      .max(3600)
      .describe("How long to sleep in seconds (5-3600)."),
    reason: z
      .string()
      .describe("Why you're sleeping this long. Logged for observability."),
  }),
  async execute(input) {
    return {
      sleepMs: input.seconds * 1000,
      reason: input.reason,
      cacheWarning:
        input.seconds > 300
          ? "Prompt cache will expire during this sleep. Next tick will be more expensive."
          : undefined,
    };
  },
});
