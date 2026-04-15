/**
 * GitHub system prompt segment — injected when GitHub connector is active.
 */

export function buildGitHubPrompt(owner: string, repo: string): string {
  return [
    "## GitHub Integration",
    "",
    `Connected to **${owner}/${repo}** via GitHub API.`,
    "",
    "Available capabilities:",
    "- Repository metadata and branch management",
    "- Webhook configuration for push/PR events",
    "- PR review with blast radius analysis",
    "- Check runs for merge gates",
    "- Commit comparison for change detection",
    "",
    "Use `github_compare` to see what changed between branches.",
    "Use `github_repo_info` to understand the repository.",
    "The webhook auto-reindexes the code graph on every push.",
  ].join("\n");
}
