# Plugin Development Guide

Build custom plugins to extend Brainstorm with new tools, hooks, and skills.

## Quick Start

```bash
mkdir my-brainstorm-plugin && cd my-brainstorm-plugin
npm init -y
npm install @brainst0rm/plugin-sdk @brainst0rm/shared zod tsup typescript
```

## Plugin Structure

```
my-brainstorm-plugin/
├── package.json
├── tsup.config.ts
├── src/
│   └── index.ts        # Default export: defineBrainstormPlugin({...})
└── dist/
    └── index.js        # Built entry point
```

### package.json

```json
{
  "name": "brainstorm-plugin-docker",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts"
  }
}
```

### src/index.ts

```typescript
import {
  defineBrainstormPlugin,
  definePluginTool,
} from "@brainst0rm/plugin-sdk";
import { z } from "zod";

export default defineBrainstormPlugin({
  name: "docker",
  description: "Docker integration for Brainstorm",
  version: "1.0.0",

  tools: [
    definePluginTool({
      name: "docker_build",
      description: "Build a Docker image from a Dockerfile",
      permission: "confirm",
      inputSchema: z.object({
        tag: z.string().describe("Image tag (e.g., myapp:latest)"),
        dockerfile: z.string().optional().describe("Path to Dockerfile"),
        context: z.string().optional().describe("Build context directory"),
      }),
      async execute({ tag, dockerfile, context }) {
        const { execFileSync } = await import("node:child_process");
        const args = ["build", "-t", tag];
        if (dockerfile) args.push("-f", dockerfile);
        args.push(context ?? ".");

        try {
          const output = execFileSync("docker", args, { encoding: "utf-8" });
          return { ok: true, data: { tag, output: output.slice(-500) } };
        } catch (err: any) {
          return { ok: false, error: err.message };
        }
      },
    }),

    definePluginTool({
      name: "docker_ps",
      description: "List running Docker containers",
      permission: "auto",
      inputSchema: z.object({}),
      async execute() {
        const { execFileSync } = await import("node:child_process");
        try {
          const output = execFileSync(
            "docker",
            ["ps", "--format", "table {{.Names}}\t{{.Image}}\t{{.Status}}"],
            {
              encoding: "utf-8",
            },
          );
          return { ok: true, data: { containers: output } };
        } catch (err: any) {
          return { ok: false, error: err.message };
        }
      },
    }),
  ],

  hooks: [
    {
      event: "SessionStart",
      command:
        'docker info > /dev/null 2>&1 || echo "WARNING: Docker daemon is not running"',
      description: "Check Docker daemon availability on session start",
    },
  ],

  skills: [
    {
      name: "containerize",
      description: "Containerize the current project with Docker",
      tools: ["docker_build", "file_write", "file_read", "shell"],
      modelPreference: "quality",
      content: `Create a production-ready Dockerfile for this project.
        1. Analyze the project structure and dependencies
        2. Write an optimized multi-stage Dockerfile
        3. Build and verify the image`,
    },
  ],

  async onLoad() {
    // Validate Docker is installed
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("docker", ["--version"], { encoding: "utf-8" });
    } catch {
      console.warn("Docker not found. docker_build tool will not work.");
    }
  },
});
```

## Installing Plugins

### Global (all projects)

```bash
cd ~/.brainstorm/plugins/
git clone https://github.com/user/brainstorm-plugin-docker.git docker
cd docker && npm install && npm run build
```

### Project-local

```bash
mkdir -p .brainstorm/plugins/docker
# Copy plugin files...
cd .brainstorm/plugins/docker && npm install && npm run build
```

Brainstorm auto-discovers plugins on startup from both locations.

## Plugin Components

### Tools

Tools are the primary extension point. They follow the same pattern as built-in tools:

- **Input schema**: Zod object describing parameters
- **Permission**: `auto` (no confirmation), `confirm` (ask user), or `deny` (blocked)
- **Execute**: Async function returning `{ ok, data?, error? }`

### Hooks

Hooks fire on lifecycle events. They run shell commands with variable expansion:

- `$FILE` — The file path (for file-related events)
- `$TOOL` — The tool name (for tool-related events)

Available events: PreToolUse, PostToolUse, SessionStart, SessionEnd, Stop, PreCompact, PreCommit, SubagentStart, SubagentStop.

### Skills

Skills are reusable instruction bundles that combine:

- A prompt/instructions (the `content` field)
- Tool restrictions (only allow specific tools)
- Model preference (cheap, quality, fast, auto)
- Max steps limit

## Best Practices

1. **Return consistent results**: Always return `{ ok: true/false, data?, error? }`.
2. **Use confirm permission** for anything that modifies the system (writes, network calls, process management).
3. **Validate in onLoad**: Check that external dependencies are available.
4. **Keep tools focused**: One tool = one action. Let the agent compose them.
5. **Name tools with underscores**: `docker_build`, not `dockerBuild` or `docker-build`.
6. **Provide descriptions**: Both tool descriptions and parameter descriptions help the agent use tools correctly.
