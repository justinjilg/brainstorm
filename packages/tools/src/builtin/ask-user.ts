import { z } from "zod";
import { defineTool } from "../base.js";

/**
 * ask_user tool — present interactive choices to the user.
 *
 * When called, emits an event for the TUI to render a SelectPrompt.
 * The user's selection is returned as the tool result. Supports both
 * simple string options and rich options with descriptions.
 */

let pendingResolver: ((answer: string) => void) | null = null;

/** Called by the CLI when the user answers a question. */
export function resolveAskUser(answer: string): void {
  if (pendingResolver) {
    const resolve = pendingResolver;
    pendingResolver = null;
    resolve(answer);
  }
}

/** Check if there's a pending question waiting for an answer. */
export function hasPendingQuestion(): boolean {
  return pendingResolver !== null;
}

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "Ask the user a question with selectable options. Use when you need to clarify requirements, " +
    "confirm a direction, or let the user choose between approaches. Present 2-5 clear options. " +
    "Mark one as recommended if you have a preference. The user sees an interactive selector.",
  permission: "auto",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the user"),
    options: z
      .array(
        z.object({
          label: z
            .string()
            .describe("Short label for the option (shown in selector)"),
          description: z
            .string()
            .optional()
            .describe("Longer description (shown when option is highlighted)"),
          recommended: z
            .boolean()
            .optional()
            .describe("Whether this is the recommended option"),
        }),
      )
      .min(2)
      .max(6)
      .describe("Options for the user to choose from"),
  }),
  async execute({ question, options }) {
    return new Promise<{ selected: string }>((resolve) => {
      pendingResolver = (answer) => {
        resolve({ selected: answer });
      };
      // Emit event for CLI to display SelectPrompt
      process.emit("brainstorm:ask-user" as any, { question, options } as any);
    });
  },
});
