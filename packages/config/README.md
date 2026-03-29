# @brainst0rm/config

Layered configuration with Zod validation. Loads and merges config from defaults, global TOML, project TOML, and environment variables.

## Key Exports

- `loadConfig()` — Load and merge all config layers
- `loadProjectContext()` — Parse BRAINSTORM.md frontmatter + body
- `brainstormConfigSchema` — Zod schema for full config validation
- `loadStormFile()` — Load a BRAINSTORM.md file
- `loadHierarchicalStormFiles()` — Load parent + child BRAINSTORM.md files

## Config Resolution

```
defaults → ~/.brainstorm/config.toml → ./brainstorm.toml → env vars
```
