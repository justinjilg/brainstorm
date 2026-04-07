/**
 * Detail Panel — contextual right panel showing tool output, diffs, terminals.
 *
 * This is the Layer 2 (contextual) surface — appears when the agent
 * produces artifacts, closes when dismissed.
 */

import { useState } from "react";
import type { ToolCallInfo } from "../../hooks/useChat";

interface DetailTab {
  id: string;
  label: string;
  type: "diff" | "terminal" | "web" | "approval" | "text";
  content: string;
  toolName?: string;
  filePath?: string;
}

interface DetailPanelProps {
  tabs: DetailTab[];
  onClose: () => void;
  onTabClose: (id: string) => void;
  activeTools: ToolCallInfo[];
}

export function DetailPanel({
  tabs,
  onClose,
  onTabClose,
  activeTools,
}: DetailPanelProps) {
  const [activeTabId, setActiveTabId] = useState<string | null>(
    tabs[0]?.id ?? null,
  );

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className="w-80 border-l border-[var(--ctp-surface0)] bg-[var(--ctp-mantle)] flex flex-col overflow-hidden">
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--ctp-surface0)]">
        <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] shrink-0 transition-colors ${
                activeTabId === tab.id
                  ? "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
                  : "text-[var(--ctp-overlay0)] hover:text-[var(--ctp-subtext0)]"
              }`}
            >
              <TypeIcon type={tab.type} />
              <span className="truncate max-w-[80px]">{tab.label}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                className="text-[var(--ctp-overlay0)] hover:text-[var(--ctp-red)] ml-0.5"
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="text-[10px] text-[var(--ctp-overlay0)] hover:text-[var(--ctp-text)] px-1 shrink-0"
        >
          ⌘D
        </button>
      </div>

      {/* Active tool calls (live) */}
      {activeTools.length > 0 && (
        <div className="px-3 py-2 border-b border-[var(--ctp-surface0)] space-y-1">
          {activeTools
            .filter((t) => t.status === "running")
            .map((tool) => (
              <div
                key={tool.id}
                className="flex items-center gap-2 text-[10px] text-[var(--ctp-yellow)]"
              >
                <span className="animate-pulse">●</span>
                <span className="font-mono">{tool.name}</span>
                <span className="text-[var(--ctp-overlay0)]">running...</span>
              </div>
            ))}
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab ? (
          <TabContent tab={activeTab} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--ctp-overlay0)]">
            No artifacts to display
          </div>
        )}
      </div>
    </div>
  );
}

function TabContent({ tab }: { tab: DetailTab }) {
  switch (tab.type) {
    case "diff":
      return <DiffView content={tab.content} filePath={tab.filePath} />;
    case "terminal":
      return <TerminalView content={tab.content} />;
    case "web":
      return <WebView content={tab.content} />;
    case "approval":
      return <ApprovalView content={tab.content} />;
    default:
      return <TextView content={tab.content} />;
  }
}

function DiffView({
  content,
  filePath,
}: {
  content: string;
  filePath?: string;
}) {
  return (
    <div className="p-3">
      {filePath && (
        <div className="text-[10px] text-[var(--ctp-overlay0)] font-mono mb-2 px-1">
          {filePath}
        </div>
      )}
      <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
        {content.split("\n").map((line, i) => {
          let color = "var(--ctp-text)";
          let bg = "transparent";
          if (line.startsWith("+") && !line.startsWith("+++")) {
            color = "var(--ctp-green)";
            bg = "rgba(166, 227, 161, 0.08)";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            color = "var(--ctp-red)";
            bg = "rgba(243, 139, 168, 0.08)";
          } else if (line.startsWith("@@")) {
            color = "var(--ctp-blue)";
          }
          return (
            <div
              key={i}
              className="px-1 -mx-1"
              style={{ color, backgroundColor: bg }}
            >
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function TerminalView({ content }: { content: string }) {
  return (
    <div className="p-3">
      <pre className="text-xs font-mono text-[var(--ctp-green)] whitespace-pre-wrap leading-relaxed bg-[var(--ctp-crust)] rounded-lg p-3">
        {content}
      </pre>
    </div>
  );
}

function WebView({ content }: { content: string }) {
  return (
    <div className="p-3">
      <div className="text-sm text-[var(--ctp-text)] whitespace-pre-wrap">
        {content.slice(0, 5000)}
        {content.length > 5000 && (
          <div className="mt-2 text-[10px] text-[var(--ctp-overlay0)]">
            Truncated ({content.length} chars total)
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalView({ content }: { content: string }) {
  return (
    <div className="p-3 space-y-3">
      <div className="p-3 rounded-lg bg-[var(--ctp-yellow)]/10 border border-[var(--ctp-yellow)]/20">
        <div className="text-xs font-medium text-[var(--ctp-yellow)] mb-2">
          ⚠ Approval Required
        </div>
        <pre className="text-xs font-mono text-[var(--ctp-text)] whitespace-pre-wrap">
          {content}
        </pre>
      </div>
      <div className="flex gap-2">
        <button className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-[var(--ctp-green)] text-[var(--ctp-crust)] hover:brightness-110">
          Allow ⌘⏎
        </button>
        <button className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-[var(--ctp-red)] text-[var(--ctp-crust)] hover:brightness-110">
          Deny ⌘⌫
        </button>
        <button className="py-1.5 px-3 rounded-lg text-xs font-medium bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
          Always
        </button>
      </div>
    </div>
  );
}

function TextView({ content }: { content: string }) {
  return (
    <div className="p-3 text-sm text-[var(--ctp-text)] whitespace-pre-wrap">
      {content}
    </div>
  );
}

function TypeIcon({ type }: { type: string }) {
  switch (type) {
    case "diff":
      return <span className="text-[var(--ctp-green)]">±</span>;
    case "terminal":
      return <span className="text-[var(--ctp-green)]">⌨</span>;
    case "web":
      return <span className="text-[var(--ctp-blue)]">🌐</span>;
    case "approval":
      return <span className="text-[var(--ctp-yellow)]">⚠</span>;
    default:
      return <span className="text-[var(--ctp-overlay0)]">📄</span>;
  }
}

/**
 * Create a detail tab from a tool call result.
 */
export function createTabFromToolResult(tool: ToolCallInfo): DetailTab | null {
  if (!tool.output) return null;
  const output = String(
    typeof tool.output === "object"
      ? JSON.stringify(tool.output, null, 2)
      : tool.output,
  );

  switch (tool.name) {
    case "file_edit":
    case "file_write":
    case "multi_edit":
    case "batch_edit":
      return {
        id: tool.id,
        label: tool.name.replace("file_", ""),
        type: "diff",
        content: output,
        toolName: tool.name,
        filePath: (tool.input as Record<string, unknown>)?.path as string,
      };

    case "shell":
    case "process_spawn":
      return {
        id: tool.id,
        label: "terminal",
        type: "terminal",
        content: output,
        toolName: tool.name,
      };

    case "web_fetch":
    case "web_search":
      return {
        id: tool.id,
        label: "web",
        type: "web",
        content: output,
        toolName: tool.name,
      };

    case "git_diff":
      return {
        id: tool.id,
        label: "diff",
        type: "diff",
        content: output,
        toolName: tool.name,
      };

    default:
      // Only create tab for tools with substantial output
      if (output.length > 100) {
        return {
          id: tool.id,
          label: tool.name,
          type: "text",
          content: output,
          toolName: tool.name,
        };
      }
      return null;
  }
}
