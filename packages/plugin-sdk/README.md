# @brainst0rm/plugin-sdk

SDK for building Brainstorm plugins. Plugins can provide custom tools, lifecycle hooks, and reusable skills.

## Quick Start

```typescript
import {
  defineBrainstormPlugin,
  definePluginTool,
} from "@brainst0rm/plugin-sdk";
import { z } from "zod";

export default defineBrainstormPlugin({
  name: "my-plugin",
  description: "My custom Brainstorm plugin",
  version: "1.0.0",

  tools: [
    definePluginTool({
      name: "my_tool",
      description: "Does something useful",
      permission: "confirm",
      inputSchema: z.object({
        input: z.string().describe("The input"),
      }),
      async execute({ input }) {
        return { ok: true, data: { result: input.toUpperCase() } };
      },
    }),
  ],

  hooks: [
    {
      event: "SessionStart",
      command: 'echo "Plugin loaded!"',
      description: "Announce plugin load",
    },
  ],

  skills: [
    {
      name: "review",
      description: "Code review skill",
      tools: ["file_read", "grep", "glob"],
      modelPreference: "quality",
      content: "Review the code for bugs and security issues.",
    },
  ],
});
```

## Installation

Plugins are installed to `~/.brainstorm/plugins/` (global) or `.brainstorm/plugins/` (project).

```bash
# Install a plugin from npm (future)
brainstorm plugin install my-brainstorm-plugin

# Or manually
cd ~/.brainstorm/plugins
git clone https://github.com/user/my-plugin.git
cd my-plugin && npm install && npm run build
```

## Plugin Structure

```
my-plugin/
├── package.json       (name, version, main)
├── src/
│   └── index.ts       (export default defineBrainstormPlugin({...}))
├── tsup.config.ts
└── dist/
    └── index.js       (built entry point)
```

## API

### `defineBrainstormPlugin(config)`

Define a plugin with tools, hooks, and skills. Validates the configuration.

### `definePluginTool(config)`

Define a tool with Zod input schema and execute function.

### `definePluginHook(config)`

Define a lifecycle hook with event, command, and optional matcher.

### `definePluginSkill(config)`

Define a reusable skill with instructions, tool restrictions, and model preferences.

### `discoverPlugins(projectPath)`

Discover and load all installed plugins from global and project directories.
