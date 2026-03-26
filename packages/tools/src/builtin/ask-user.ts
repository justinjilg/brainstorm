import { z } from 'zod';
import { defineTool } from '../base.js';

/**
 * Ask-User Tool — pauses execution and asks the user a question.
 *
 * The tool emits a 'brainstorm:ask-user' event on process. The CLI
 * listens for this event, displays the question, waits for user input,
 * and calls the resolver to resume execution.
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
  name: 'ask_user',
  description: 'Pause and ask the user a question. Use for design decisions with multiple valid approaches, not routine confirmations. Returns { answer: string }.',
  permission: 'auto',
  inputSchema: z.object({
    question: z.string().describe('The question to ask the user'),
    options: z.array(z.string()).optional().describe('Optional choices (user can also type free text)'),
  }),
  async execute({ question, options }) {
    return new Promise<{ answer: string }>((resolve) => {
      pendingResolver = (answer) => {
        resolve({ answer });
      };
      // Emit event for CLI to display and handle
      process.emit('brainstorm:ask-user' as any, { question, options } as any);
    });
  },
});
