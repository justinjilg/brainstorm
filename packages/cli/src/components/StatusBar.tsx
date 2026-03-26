import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "@brainstorm/shared";

interface StatusBarProps {
  strategy: string;
  currentModel?: string;
  sessionCost: number;
  modelCount: { local: number; cloud: number };
  permissionMode?: PermissionMode;
  tokenCount?: { input: number; output: number };
  sessionId?: string;
  /** Context budget from context-budget events. */
  contextBudget?: { used: number; limit: number; percent: number };
  /** Build status from build state tracker. */
  buildStatus?: "passing" | "failing" | "unknown";
  /** Whether a request is in progress. */
  isProcessing?: boolean;
}

const MODE_LABELS: Record<PermissionMode, { label: string; color: string }> = {
  auto: { label: "auto", color: "green" },
  confirm: { label: "confirm", color: "yellow" },
  plan: { label: "plan", color: "cyan" },
};

// Provider-based model coloring
function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "magenta";
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.includes("o1") ||
    lower.includes("o3")
  )
    return "green";
  if (lower.includes("gemini") || lower.includes("google")) return "blue";
  if (
    lower.includes("llama") ||
    lower.includes("mistral") ||
    lower.includes("qwen")
  )
    return "cyan";
  if (lower.includes("deepseek")) return "yellow";
  return "white";
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function renderBudgetBar(percent: number, width = 12): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function getBudgetColor(percent: number): string {
  if (percent >= 85) return "red";
  if (percent >= 60) return "yellow";
  return "green";
}

export function StatusBar({
  strategy,
  currentModel,
  sessionCost,
  modelCount,
  permissionMode = "confirm",
  tokenCount,
  sessionId,
  contextBudget,
  buildStatus,
  isProcessing,
}: StatusBarProps) {
  const mode = MODE_LABELS[permissionMode];
  const totalTokens = tokenCount ? tokenCount.input + tokenCount.output : 0;

  return (
    <Box flexDirection="column">
      {/* Row 1: Primary status */}
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Text>
          <Text color={mode.color} bold>
            {mode.label}
          </Text>
          <Text color="gray"> │ </Text>
          {currentModel ? (
            <Text color={getModelColor(currentModel)} bold>
              {currentModel}
            </Text>
          ) : (
            <Text color="gray">{strategy} routing</Text>
          )}
          {totalTokens > 0 && (
            <>
              <Text color="gray"> │ </Text>
              <Text>
                {formatTokens(tokenCount!.input)}↑{" "}
                {formatTokens(tokenCount!.output)}↓
              </Text>
            </>
          )}
          <Text color="gray"> │ </Text>
          <Text color={sessionCost > 0.01 ? "yellow" : "green"}>
            ${sessionCost.toFixed(4)}
          </Text>
        </Text>
        <Text>
          <Text color="gray">
            {modelCount.local}L/{modelCount.cloud}C
          </Text>
          {sessionId && (
            <>
              <Text color="gray"> │ </Text>
              <Text color="gray">{sessionId.slice(0, 8)}</Text>
            </>
          )}
        </Text>
      </Box>

      {/* Row 2: Context budget + build status (shown only when relevant) */}
      {(contextBudget || buildStatus === "failing") && (
        <Box paddingX={2} flexDirection="row" justifyContent="space-between">
          {contextBudget && (
            <Text>
              <Text color="gray">ctx </Text>
              <Text color={getBudgetColor(contextBudget.percent)}>
                {renderBudgetBar(contextBudget.percent)}
              </Text>
              <Text color="gray"> {contextBudget.percent}%</Text>
            </Text>
          )}
          {buildStatus === "failing" && (
            <Text color="red" bold>
              {" "}
              build: failing
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
