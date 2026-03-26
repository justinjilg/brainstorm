import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface ToolCallState {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  startTime: number;
  duration?: number;
  result?: string;
  ok?: boolean;
}

// Extract a human-readable summary of tool args
function summarizeArgs(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "file_read":
    case "file_write":
    case "file_edit":
      return String(args.file_path ?? args.path ?? "")
        .split("/")
        .slice(-2)
        .join("/");
    case "multi_edit":
    case "batch_edit":
      return `${Array.isArray(args.edits) ? args.edits.length : "?"} edits`;
    case "shell":
      return String(args.command ?? "").slice(0, 60);
    case "grep":
      return `/${args.pattern ?? ""}/ ${args.path ?? ""}`.slice(0, 50);
    case "glob":
      return String(args.pattern ?? "").slice(0, 50);
    case "web_search":
      return String(args.query ?? "").slice(0, 50);
    case "web_fetch":
      return String(args.url ?? "").slice(0, 50);
    case "git_commit":
      return String(args.message ?? "").slice(0, 50);
    case "subagent":
      return `[${args.type ?? "general"}] ${String(args.task ?? "").slice(0, 40)}`;
    default:
      return "";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface ToolCallDisplayProps {
  tool: ToolCallState;
}

export function ToolCallDisplay({ tool }: ToolCallDisplayProps) {
  const argSummary = summarizeArgs(tool.toolName, tool.args);

  if (tool.status === "running") {
    const elapsed = Date.now() - tool.startTime;
    return (
      <Box paddingLeft={2}>
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
        <Text color="yellow" bold>
          {" "}
          {tool.toolName}
        </Text>
        {argSummary && <Text color="gray"> {argSummary}</Text>}
        <Text color="gray" dimColor>
          {" "}
          ({formatDuration(elapsed)})
        </Text>
      </Box>
    );
  }

  const icon = tool.ok !== false ? "✓" : "✗";
  const color = tool.ok !== false ? "green" : "red";

  return (
    <Box paddingLeft={2}>
      <Text color={color}>{icon}</Text>
      <Text color="gray"> {tool.toolName}</Text>
      {argSummary && (
        <Text color="gray" dimColor>
          {" "}
          {argSummary}
        </Text>
      )}
      {tool.duration !== undefined && (
        <Text color="gray" dimColor>
          {" "}
          ({formatDuration(tool.duration)})
        </Text>
      )}
    </Box>
  );
}

interface ToolCallListProps {
  tools: ToolCallState[];
}

export function ToolCallList({ tools }: ToolCallListProps) {
  if (tools.length === 0) return null;

  // Show running tools, plus last 3 completed
  const running = tools.filter((t) => t.status === "running");
  const completed = tools.filter((t) => t.status !== "running").slice(-3);
  const visible = [...completed, ...running];

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((tool) => (
        <ToolCallDisplay key={tool.id} tool={tool} />
      ))}
    </Box>
  );
}
