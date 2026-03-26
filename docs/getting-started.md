# Getting Started

Get up and running with Brainstorm in 5 minutes.

## Install

```bash
npm install -g @brainstorm/cli
```

## Configure

### Option A: BrainstormRouter (Recommended)

Sign up at [brainstormrouter.com](https://brainstormrouter.com) for an API key. This gives you access to 357+ models across 7 providers with intelligent routing.

```bash
storm vault add BRAINSTORM_API_KEY
# Paste your key when prompted
```

### Option B: Direct Provider Keys

If you prefer to use providers directly:

```bash
storm vault add ANTHROPIC_API_KEY
# or
storm vault add OPENAI_API_KEY
```

### Option C: Local Models Only

No API key needed. Just have Ollama running:

```bash
# Install Ollama (https://ollama.ai)
ollama serve
ollama pull llama3.2

# Brainstorm auto-discovers local models
storm models
```

## First Session

```bash
# Interactive chat (default)
storm chat

# Single prompt with tools
storm run --tools "What files are in this project?"

# Full auto mode (skip confirmations)
storm run --tools --lfg "Read the codebase and explain the architecture"
```

## Project Context

Create a `BRAINSTORM.md` in your project root to give Brainstorm context:

```markdown
---
build_command: npm run build
test_command: npm test
---

# My Project

This is a Next.js app with Drizzle ORM.

## Conventions
- Components go in src/components/
- Use server components by default
- Tests use vitest
```

Brainstorm reads this file automatically and uses it to make better decisions.

## Slash Commands

In chat mode, use slash commands:

| Command | Action |
|---------|--------|
| `/model` | Switch models |
| `/fast` | Toggle fast mode |
| `/compact` | Compress context window |
| `/clear` | Reset conversation |
| `/help` | Show all commands |
| `/dream` | Consolidate session memories |

## Check Your Setup

```bash
# Verify models are available
storm models

# Check configuration
storm config

# View budget and costs
storm budget
```

## Next Steps

- Read [Architecture](architecture.md) to understand how Brainstorm works
- See [Tools Reference](tools.md) for all 42 built-in tools
- Check [Configuration Guide](config-guide.md) for all options
- Learn about [BrainstormRouter Integration](brainstormrouter-integration.md)
- Build a [Plugin](plugin-development.md) to extend Brainstorm
