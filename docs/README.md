# Documentation

## Start Here

| Doc                                       | What                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [Getting Started](getting-started.md)     | Install, configure, first session                                     |
| [Feature Reference](feature-reference.md) | Every tool, command, agent, strategy, middleware, hook, config option |
| [Configuration Guide](config-guide.md)    | TOML schema, env vars, BRAINSTORM.md format                           |

## Architecture

| Doc                                                             | What                                            |
| --------------------------------------------------------------- | ----------------------------------------------- |
| [Architecture](architecture.md)                                 | Package graph, data flow, intelligence features |
| [Tools Reference](tools.md)                                     | All 58+ tools by category                       |
| [BrainstormRouter Integration](brainstormrouter-integration.md) | BR tools and intelligence API                   |

## Governance & Channels

| Doc                                                                       | What                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`brainstorm audit report`](getting-started.md#brainstorm-audit-report)   | Render ChangeSet audit entries to an HTML evidence report + signed `evidence.json` |
| [`brainstorm serve` / Slack channel](getting-started.md#brainstorm-serve) | Message gateway (Slack Socket Mode) driving the governed agent loop                |
| [`[channels.slack]` config](config-guide.md#full-schema)                  | Slack adapter config: mode, tokens, authority, channel/user allowlists             |
| [`[shell.sandboxPool]` config](config-guide.md#full-schema)               | Docker sandbox warm pool: idle limits, eviction timeout                            |

## Extending

| Doc                                         | What                        |
| ------------------------------------------- | --------------------------- |
| [Plugin Development](plugin-development.md) | Custom tools, hooks, skills |
