import type * as vscode from 'vscode';
import { BrainstormChatProvider } from './chat-provider.js';

/**
 * VS Code Extension entry point.
 *
 * Registers:
 * - @brainstorm chat participant
 * - brainstorm.startChat command
 * - brainstorm.selectModel command
 */

let chatProvider: BrainstormChatProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  chatProvider = new BrainstormChatProvider(context);

  // Register chat participant
  const participant = (globalThis as any).vscode?.chat?.createChatParticipant?.(
    'brainstorm',
    (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken,
    ) => chatProvider!.handleRequest(request, chatContext, stream, token),
  );

  if (participant) {
    participant.iconPath = {
      light: (globalThis as any).vscode?.Uri?.joinPath?.(context.extensionUri, 'media', 'icon-light.svg'),
      dark: (globalThis as any).vscode?.Uri?.joinPath?.(context.extensionUri, 'media', 'icon-dark.svg'),
    };
    context.subscriptions.push(participant);
  }

  // Register commands
  const startChat = (globalThis as any).vscode?.commands?.registerCommand?.(
    'brainstorm.startChat',
    () => {
      (globalThis as any).vscode?.commands?.executeCommand?.('workbench.action.chat.open', { participant: 'brainstorm' });
    },
  );
  if (startChat) context.subscriptions.push(startChat);

  const selectModel = (globalThis as any).vscode?.commands?.registerCommand?.(
    'brainstorm.selectModel',
    async () => {
      const models = ['claude-sonnet-4.5', 'gpt-4.1', 'gemini-2.5-pro', 'llama-3.2'];
      const selected = await (globalThis as any).vscode?.window?.showQuickPick?.(models, {
        placeHolder: 'Select a model for Brainstorm',
      });
      if (selected) {
        chatProvider?.dispose();
        // Model selection would be passed to the storm process in a full implementation
      }
    },
  );
  if (selectModel) context.subscriptions.push(selectModel);
}

export function deactivate(): void {
  chatProvider?.dispose();
  chatProvider = null;
}
