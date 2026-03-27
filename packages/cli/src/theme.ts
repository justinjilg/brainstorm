/**
 * Brainstorm TUI Theme — Catppuccin Mocha-inspired color palette.
 * All colors are semantic: used for meaning, not decoration.
 */

export const theme = {
  // Backgrounds
  base: "#1e1e2e",
  surface: "#313244",
  border: "#45475a",

  // Text
  text: "#cdd6f4",
  subtext: "#a6adc8",
  dim: "#6c7086",

  // Semantic colors
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  mauve: "#cba6f7",
  teal: "#94e2d5",
  peach: "#fab387",
  pink: "#f5c2e7",
  sky: "#89dceb",
  lavender: "#b4befe",
} as const;

/** Provider → color mapping */
export function getProviderColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) return "magenta";
  if (p.includes("openai") || p.includes("gpt") || p.includes("o3"))
    return "yellow";
  if (p.includes("google") || p.includes("gemini")) return "blue";
  if (p.includes("deepseek")) return "cyan";
  if (p.includes("local") || p.includes("ollama") || p.includes("lmstudio"))
    return "white";
  return "gray";
}

/** Role → color mapping */
export function getRoleColor(role: string): string {
  switch (role) {
    case "architect":
      return "magenta";
    case "product-manager":
      return "blue";
    case "sr-developer":
      return "green";
    case "jr-developer":
      return "yellow";
    case "qa":
      return "red";
    default:
      return "gray";
  }
}

/** Budget percentage → color */
export function getBudgetColor(percent: number): string {
  if (percent >= 85) return "red";
  if (percent >= 60) return "yellow";
  return "green";
}
