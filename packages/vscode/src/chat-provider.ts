import type * as vscode from "vscode";
import { StormProcess } from "./storm-process.js";

/**
 * VS Code Chat Participant handler.
 *
 * Registers as @brainstorm in VS Code's chat panel.
 * Spawns a storm CLI process and pipes messages between VS Code and storm.
 */
export class BrainstormChatProvider {
  private stormProcess: StormProcess | null = null;
  private preferredModel: string | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  /** Set the preferred model — restarts storm process to apply. */
  setPreferredModel(modelId: string | undefined): void {
    this.preferredModel = modelId;
    // Restart process to pick up new model
    this.stormProcess?.stop();
    this.stormProcess = null;
  }

  /** Handle a chat request from VS Code. */
  async handleRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    // Ensure storm process is running
    const storm = this.getOrCreateProcess();

    return new Promise<vscode.ChatResult>((resolve) => {
      let responseText = "";

      const onEvent = (event: { type: string; data: unknown }) => {
        if (token.isCancellationRequested) {
          cleanup();
          resolve({ metadata: { cancelled: true } });
          return;
        }

        switch (event.type) {
          case "text":
            if (typeof event.data === "string") {
              stream.markdown(event.data);
              responseText += event.data;
            }
            break;

          case "tool-call":
            if (typeof event.data === "object" && event.data !== null) {
              const tc = event.data as { name: string; input?: unknown };
              stream.progress(`Running tool: ${tc.name}`);
            }
            break;

          case "tool-result":
            // Tool results are consumed by the model, not shown to user
            break;

          case "done":
            cleanup();
            resolve({ metadata: { responseLength: responseText.length } });
            break;

          case "error":
            stream.markdown(`\n\n**Error:** ${String(event.data)}`);
            cleanup();
            resolve({ metadata: { error: true } });
            break;
        }
      };

      const onText = (text: string) => {
        if (!token.isCancellationRequested) {
          stream.markdown(text);
          responseText += text;
        }
      };

      const cleanup = () => {
        storm.removeListener("event", onEvent);
        storm.removeListener("text", onText);
      };

      storm.on("event", onEvent);
      storm.on("text", onText);

      // Include active file context if available
      const activeFile = this.getActiveFilePath();
      const prefix = activeFile ? `[Context: ${activeFile}]\n` : "";

      storm.send(prefix + request.prompt);

      // Handle cancellation
      token.onCancellationRequested(() => {
        cleanup();
        resolve({ metadata: { cancelled: true } });
      });
    });
  }

  /** Get or create the storm process for this workspace. */
  private getOrCreateProcess(): StormProcess {
    if (this.stormProcess?.isRunning()) {
      return this.stormProcess;
    }

    const workspaceFolder = this.getWorkspacePath();
    this.stormProcess = new StormProcess(workspaceFolder, this.preferredModel);
    this.stormProcess.start();

    this.stormProcess.on("exit", () => {
      this.stormProcess = null;
    });

    return this.stormProcess;
  }

  /** Get the active file path for context injection. */
  private getActiveFilePath(): string | undefined {
    const vscodeApi = (globalThis as any).vscode;
    const editor = vscodeApi?.window?.activeTextEditor;
    return editor?.document?.uri?.fsPath;
  }

  /** Get the workspace root path. */
  private getWorkspacePath(): string {
    const vscodeApi = (globalThis as any).vscode;
    const folders = vscodeApi?.workspace?.workspaceFolders;
    return folders?.[0]?.uri?.fsPath ?? process.cwd();
  }

  /** Dispose the provider and clean up. */
  dispose(): void {
    this.stormProcess?.stop();
    this.stormProcess = null;
  }
}
