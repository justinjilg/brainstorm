# @brainstorm/cli

Commander-based CLI with Ink TUI. Entry point: `src/bin/brainstorm.ts`. Alias: `storm`.

## Commands

| Command | Description |
|---------|------------|
| `storm chat` | Interactive chat (default) |
| `storm run "prompt"` | Non-interactive single prompt |
| `storm models` | List available models |
| `storm config` | Show current configuration |
| `storm budget` | Show cost tracking |
| `storm agent` | Manage agent profiles |
| `storm workflow` | Run preset workflows |
| `storm sessions` | List past sessions |
| `storm vault` | Manage API keys |
| `storm eval` | Run capability evaluations |

## Flags

| Flag | Description |
|------|------------|
| `--tools` | Enable tool calling |
| `--lfg` | Auto-approve all tool calls |
| `--model <id>` | Override model selection |
| `--strategy <name>` | Override routing strategy |
| `--simple` | Plain text mode (no TUI) |

## Built-in Slash Commands

`/model`, `/fast`, `/compact`, `/clear`, `/help`, `/dream`, `/vault`
