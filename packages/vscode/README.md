# @brainst0rm/vscode

VS Code extension for Brainstorm AI. Registers as a chat participant (`@brainstorm`) in VS Code's chat panel.

## Architecture

The extension spawns `storm chat --simple --pipe` as a child process and pipes messages between VS Code and the storm CLI. This means:

- All Brainstorm features work in VS Code (routing, tools, memory, etc.)
- No separate backend needed — uses the same CLI
- Active file context is automatically included

## Components

- `extension.ts` — Entry point, registers chat participant and commands
- `chat-provider.ts` — Handles VS Code chat requests, manages storm process
- `storm-process.ts` — Spawns and manages the storm CLI child process

## Commands

- `brainstorm.startChat` — Open Brainstorm chat panel
- `brainstorm.selectModel` — Switch model via quick pick

## Development

```bash
cd packages/vscode
npm run build
# Press F5 in VS Code to launch extension host
```

## Requirements

- VS Code 1.90+ (chat participant API)
- `storm` CLI installed and available in PATH
