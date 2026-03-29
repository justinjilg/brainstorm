# @brainst0rm/providers

AI provider discovery and AI SDK language model creation.

## Key Exports

- `ProviderRegistry` — Manages all providers, creates AI SDK language models
- `discoverLocalModels()` — Auto-discover Ollama, LM Studio, llama.cpp

## Supported Providers

**Cloud:** BrainstormRouter (357+ models), Anthropic, OpenAI, Google, DeepSeek, xAI, Mistral
**Local:** Ollama (`:11434`), LM Studio (`:1234`), llama.cpp (`:8080`)

## Usage

```typescript
import { ProviderRegistry } from "@brainst0rm/providers";

const registry = new ProviderRegistry(config);
const model = registry.createLanguageModel("claude-sonnet-4.5");
```
