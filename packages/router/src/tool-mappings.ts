/**
 * Per-provider tool name mappings.
 *
 * Brainstorm uses Anthropic conventions as canonical tool names.
 * When routing to non-Anthropic models, we rename tools to match what
 * each model was trained on, improving tool-call accuracy.
 *
 * Keys: canonical Brainstorm tool name → value: provider-specific name.
 * Only tools that need renaming are listed; unlisted tools pass through.
 */

export const PROVIDER_TOOL_NAMES: Record<string, Record<string, string>> = {
  openai: {
    bash: "shell_command",
    file_read: "read_file",
    file_write: "write_file",
    file_edit: "apply_patch",
  },
  google: {
    bash: "run_shell_command",
    file_write: "write_file",
    file_edit: "replace",
  },
  deepseek: {
    bash: "shell_command",
    file_read: "read_file",
    file_write: "write_file",
  },
};

/**
 * Extract the provider family from a model ID or provider string.
 * e.g., "anthropic" → "anthropic", "openai/gpt-5.4" → "openai",
 *       "google" → "google", "deepseek" → "deepseek"
 */
export function getProviderFamily(provider: string): string {
  // Provider strings may include slashes (e.g., "openai/gpt-5.4")
  return provider.split("/")[0].toLowerCase();
}
