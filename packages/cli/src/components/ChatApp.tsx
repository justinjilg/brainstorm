import React, { useState, useCallback, useMemo, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { StatusBar } from "./StatusBar.js";
import { MessageList, type ChatMessage } from "./MessageList.js";
import { TaskList } from "./TaskList.js";
import { StreamingMessage } from "./StreamingMessage.js";
import { ToolCallList, type ToolCallState } from "./ToolCallDisplay.js";
import { SelectPrompt, type SelectOption } from "./SelectPrompt.js";
import { Autocomplete, type AutocompleteItem } from "./Autocomplete.js";
import { getSlashCommands } from "../commands/slash.js";
import {
  isSlashCommand,
  executeSlashCommand,
  type SlashContext,
} from "../commands/slash.js";
import { resolveKeyAction } from "../keybindings.js";
import { InputHistory } from "../input-history.js";
import type {
  AgentEvent,
  AgentTask,
  RoutingDecision,
} from "@brainstorm/shared";

interface ChatAppProps {
  strategy: string;
  modelCount: { local: number; cloud: number };
  onSendMessage: (text: string) => AsyncGenerator<AgentEvent>;
  onAbort?: () => void;
  /** When false, ChatApp ignores keyboard input (hidden behind another mode). */
  isActive?: boolean;
  /** Mutable context for slash commands — callbacks that affect session state */
  slashCallbacks?: {
    setModel?: (model: string) => void;
    setStrategy?: (strategy: string) => void;
    getStrategy?: () => string;
    setMode?: (mode: string) => void;
    getMode?: () => string;
    rebuildSystemPrompt?: (basePromptOverride?: string) => void;
    getActiveRole?: () => string | undefined;
    setActiveRole?: (role: string | undefined) => void;
    setOutputStyle?: (style: string) => void;
    getOutputStyle?: () => string;
    getBudget?: () => { remaining: number; limit: number } | null;
    compact?: () => Promise<void>;
    dream?: () => Promise<string>;
    vault?: (action: string, args: string) => Promise<string>;
  };
}

export function ChatApp({
  strategy,
  modelCount,
  onSendMessage,
  onAbort,
  isActive = true,
  slashCallbacks,
}: ChatAppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState<string | undefined>(
    undefined,
  );
  const [currentModel, setCurrentModel] = useState<string | undefined>(
    undefined,
  );
  const [sessionCost, setSessionCost] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tokenCount, setTokenCount] = useState<{
    input: number;
    output: number;
  }>({ input: 0, output: 0 });
  const [thinkingPhase, setThinkingPhase] = useState<string | undefined>(
    undefined,
  );
  const [activeTools, setActiveTools] = useState<ToolCallState[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [askUserPrompt, setAskUserPrompt] = useState<{
    question: string;
    options: SelectOption[];
  } | null>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [history] = useState(() => new InputHistory());

  // Build slash command autocomplete items once
  const slashItems = useMemo<AutocompleteItem[]>(() => {
    return getSlashCommands().map((cmd) => ({
      label: cmd.name,
      description: cmd.description,
      prefix: "/",
    }));
  }, []);

  // Listen for ask_user tool events
  useEffect(() => {
    const handler = (data: any) => {
      if (data?.question && data?.options) {
        setAskUserPrompt({
          question: data.question,
          options: data.options.map((o: any) => ({
            label: o.label ?? o,
            value: o.label ?? o,
            description: o.description,
            recommended: o.recommended,
          })),
        });
      }
    };
    process.on("brainstorm:ask-user" as any, handler);
    return () => {
      process.removeListener("brainstorm:ask-user" as any, handler);
    };
  }, []);

  // Keybinding handler + input history navigation + scrolling
  useInput((inputChar, key) => {
    // Skip all input when ChatApp is not the active mode
    if (!isActive) return;

    // Shift+Up/Down for scrolling message history
    if (key.upArrow && key.shift) {
      setScrollOffset((prev) =>
        Math.min(prev + 3, Math.max(0, messages.length - 3)),
      );
      return;
    }
    if (key.downArrow && key.shift) {
      setScrollOffset((prev) => Math.max(0, prev - 3));
      return;
    }

    // Up/Down arrow for input history
    if (key.upArrow && !isProcessing) {
      const prev = history.up(input);
      if (prev !== null) setInput(prev);
      return;
    }
    if (key.downArrow && !isProcessing) {
      const next = history.down();
      if (next !== null) setInput(next);
      return;
    }

    const action = resolveKeyAction(inputChar, key as any);
    if (!action) return;

    switch (action) {
      case "abort":
        if (isProcessing) {
          onAbort?.();
          // Safety: force-reset processing state after abort
          setTimeout(() => {
            setIsProcessing(false);
            setStreamingText(undefined);
            setThinkingPhase(undefined);
          }, 2000);
        }
        break;
      case "exit":
        exit();
        break;
      case "clear-screen":
        process.stdout.write("\x1B[2J\x1B[0f");
        break;
      case "clear-chat":
        setMessages([]);
        setStreamingText(undefined);
        break;
      case "cycle-mode": {
        const modes = ["auto", "confirm", "plan"] as const;
        const current = slashCallbacks?.getMode?.() ?? "confirm";
        const idx = modes.indexOf(current as any);
        const next = modes[(idx + 1) % modes.length];
        slashCallbacks?.setMode?.(next);
        // Show mode change as routing message
        const labels: Record<string, string> = {
          auto: "auto (all tools allowed)",
          confirm: "confirm (ask before writes)",
          plan: "plan (read-only)",
        };
        setMessages((prev) => [
          ...prev,
          { role: "routing", content: `Mode: ${labels[next] ?? next}` },
        ]);
        break;
      }
    }
  });

  const slashCtx: SlashContext = useMemo(
    () => ({
      getModel: () => currentModel,
      getSessionCost: () => sessionCost,
      getTokenCount: () => tokenCount,
      exit: () => exit(),
      clearHistory: () => {
        setMessages([]);
        setStreamingText(undefined);
      },
      setModel: (model: string) => {
        slashCallbacks?.setModel?.(model);
        // Update displayed model name immediately (don't wait for routing event)
        const name = model.split("/").pop() ?? model;
        setCurrentModel(name);
      },
      setStrategy: slashCallbacks?.setStrategy,
      getStrategy: slashCallbacks?.getStrategy,
      setMode: slashCallbacks?.setMode,
      getMode: slashCallbacks?.getMode,
      setOutputStyle: slashCallbacks?.setOutputStyle,
      getOutputStyle: slashCallbacks?.getOutputStyle,
      getBudget: slashCallbacks?.getBudget,
      compact: slashCallbacks?.compact,
      getContextWindow: slashCallbacks?.getContextWindow,
      dream: slashCallbacks?.dream,
      vault: slashCallbacks?.vault,
      rebuildSystemPrompt: slashCallbacks?.rebuildSystemPrompt,
      undoLastTurn: () => {
        // Find last user message and remove it + everything after
        let removed = 0;
        setMessages((prev) => {
          const lastUserIdx = prev.findLastIndex((m) => m.role === "user");
          if (lastUserIdx < 0) return prev;
          removed = prev.length - lastUserIdx;
          return prev.slice(0, lastUserIdx);
        });
        return removed;
      },
      getActiveRole: slashCallbacks?.getActiveRole,
      setActiveRole: slashCallbacks?.setActiveRole,
      gateway: slashCallbacks?.gateway,
    }),
    [currentModel, sessionCost, tokenCount, exit, slashCallbacks],
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      if (isProcessing) return;
      if (!text.trim()) {
        // Brief hint for empty input
        setMessages((prev) => [
          ...prev,
          {
            role: "routing",
            content: "Type a message or use /help for commands",
          },
        ]);
        return;
      }
      history.push(text.trim());

      // Handle slash commands
      if (isSlashCommand(text)) {
        setInput("");
        const result = await executeSlashCommand(text, slashCtx);
        // Use 'assistant' role for readable output (not dim 'routing')
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result },
        ]);
        return;
      }

      setInput("");
      setMessages((prev) => [...prev, { role: "user", content: text.trim() }]);
      setIsProcessing(true);
      setStreamingText("");
      setTasks([]);
      setActiveTools([]);
      setScrollOffset(0);

      let fullResponse = "";
      let model: string | undefined;
      let cost = 0;
      const costBefore = sessionCost;

      try {
        for await (const event of onSendMessage(text.trim())) {
          switch (event.type) {
            case "thinking":
              setThinkingPhase(event.phase);
              break;
            case "routing":
              model = event.decision.model.name;
              setCurrentModel(model);
              setThinkingPhase(undefined);
              const est = event.decision.estimatedCost;
              const estStr = est > 0 ? ` ~$${est.toFixed(3)}` : "";
              const fb = event.decision.fallbacks?.length ?? 0;
              const fbStr =
                fb > 0 ? ` (${fb} fallback${fb > 1 ? "s" : ""})` : "";
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `→ ${model} via ${event.decision.strategy}${estStr}${fbStr}`,
                },
              ]);
              break;
            case "text-delta":
              setThinkingPhase(undefined);
              fullResponse += event.delta;
              setStreamingText(fullResponse);
              break;
            case "reasoning":
              setMessages((prev) => [
                ...prev,
                { role: "reasoning", content: event.content },
              ]);
              break;
            case "tool-call-start":
              setActiveTools((prev) => [
                ...prev,
                {
                  id: `tc-${Date.now()}-${event.toolName}`,
                  toolName: event.toolName,
                  args: (event.args ?? {}) as Record<string, unknown>,
                  status: "running",
                  startTime: Date.now(),
                },
              ]);
              break;
            case "tool-call-result":
              setActiveTools((prev) => {
                // Find the most recent running tool with this name
                const idx = prev.findLastIndex(
                  (t) =>
                    t.status === "running" && t.toolName === event.toolName,
                );
                if (idx < 0) return prev;
                const updated = [...prev];
                updated[idx] = {
                  ...updated[idx],
                  status: "done",
                  duration: Date.now() - updated[idx].startTime,
                  ok: true,
                };
                return updated;
              });
              break;
            case "compaction":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `context compacted — ${event.removed} messages summarized (${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} tokens)`,
                },
              ]);
              break;
            case "subagent-result":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `subagent [${event.subagentType}] → ${event.model} ($${event.cost.toFixed(4)}, ${event.toolCalls.length} tool calls)`,
                },
              ]);
              break;
            case "task-created":
              setTasks((prev) => [...prev, event.task]);
              break;
            case "task-updated":
              setTasks((prev) =>
                prev.map((t) => (t.id === event.task.id ? event.task : t)),
              );
              break;
            case "background-complete":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `[bg] ${event.taskId} completed (exit ${event.exitCode}): ${event.command.slice(0, 60)}`,
                },
              ]);
              break;
            case "model-retry":
              setCurrentModel(event.toModel);
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `↻ retry: ${event.fromModel} → ${event.toModel} (${event.reason})`,
                },
              ]);
              break;
            case "fallback-exhausted":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `⚠ all models failed: ${event.modelsTried.join(", ")}`,
                },
              ]);
              break;
            case "budget-warning":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `⚠ budget: $${event.used.toFixed(4)} / $${event.limit.toFixed(4)} ($${event.remaining.toFixed(4)} remaining)`,
                },
              ]);
              break;
            case "context-budget":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `context: ${event.percent}% (${event.used.toLocaleString()} / ${event.limit.toLocaleString()} tokens)`,
                },
              ]);
              break;
            case "loop-warning":
              // Loop warnings are injected into model context, not shown to user.
              // They clutter the UI with internal guidance like "file_read called 3 times".
              break;
            case "empty-response":
              setMessages((prev) => [
                ...prev,
                {
                  role: "routing",
                  content: `⚠ empty response from ${event.modelId}`,
                },
              ]);
              break;
            case "gateway-feedback":
              // Silently update — displayed in StatusBar in future
              break;
            case "tool-output-partial":
              // Live tool output — update active tool display in future
              break;
            case "interrupted":
              setMessages((prev) => [
                ...prev,
                { role: "routing", content: "interrupted" },
              ]);
              break;
            case "done":
              cost = event.totalCost - costBefore; // Per-turn cost delta
              setSessionCost(event.totalCost);
              if (event.totalTokens) setTokenCount(event.totalTokens);
              break;
            case "error": {
              // Categorize error for better UX
              const msg = event.error.message ?? "";
              const category =
                msg.includes("fetch") || msg.includes("ECONNREFUSED")
                  ? "NETWORK"
                  : msg.includes("Budget") || msg.includes("budget")
                    ? "BUDGET"
                    : msg.includes("Unauthorized") || msg.includes("401")
                      ? "AUTH"
                      : msg.includes("No models")
                        ? "MODEL"
                        : "ERROR";
              const hint =
                category === "NETWORK"
                  ? "\nCheck your internet connection."
                  : category === "BUDGET"
                    ? "\nRun /budget to check. Adjust in config.toml."
                    : category === "AUTH"
                      ? "\nRun /vault list to check API keys."
                      : category === "MODEL"
                        ? "\nRun /model to switch or check available models."
                        : "";
              setMessages((prev) => [
                ...prev,
                {
                  role: "error" as any,
                  content: `[${category}] ${msg}${hint}`,
                  model,
                },
              ]);
              break;
            }
          }
        }
      } catch (err: any) {
        fullResponse = `Error: ${err.message}`;
      } finally {
        setStreamingText(undefined);
        setThinkingPhase(undefined);
        setIsProcessing(false);
      }

      // Always show assistant message — even empty responses should display cost
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: fullResponse || "(No response received)",
          model,
          cost,
        },
      ]);
    },
    [isProcessing, onSendMessage, exit, slashCtx],
  );

  // Compute available height for messages (App manages outer height)
  const termHeight = process.stdout.rows || 24;
  const footerHeight = 4; // Input box + key hints
  const toolsHeight =
    activeTools.filter((t) => t.status === "running").length > 0 ? 4 : 0;
  const tasksHeight = tasks.length > 0 ? Math.min(tasks.length + 1, 5) : 0;
  const messageHeight = Math.max(
    5,
    termHeight - 2 - footerHeight - toolsHeight - tasksHeight,
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <MessageList
        messages={messages}
        maxHeight={messageHeight}
        scrollOffset={scrollOffset}
      />
      {(streamingText !== undefined || thinkingPhase) && (
        <StreamingMessage
          content={streamingText ?? ""}
          isStreaming={isProcessing}
          phase={thinkingPhase}
          model={currentModel}
        />
      )}
      <ToolCallList tools={activeTools} />
      {tasks.length > 0 && <TaskList tasks={tasks} />}
      {/* Slash command autocomplete */}
      {showAutocomplete && !isProcessing && !askUserPrompt && (
        <Autocomplete
          query={input.slice(1)}
          items={slashItems}
          onAccept={(label) => {
            setInput(`/${label} `);
            setShowAutocomplete(false);
          }}
          onDismiss={() => setShowAutocomplete(false)}
        />
      )}

      {/* Interactive selection prompt (from ask_user tool) */}
      {askUserPrompt && (
        <SelectPrompt
          message={askUserPrompt.question}
          options={askUserPrompt.options}
          onSelect={async (value) => {
            const { resolveAskUser } = await import("@brainstorm/tools");
            resolveAskUser(value);
            setAskUserPrompt(null);
            setMessages((prev) => [
              ...prev,
              { role: "routing", content: `Selected: ${value}` },
            ]);
          }}
          onCancel={async () => {
            const { resolveAskUser } = await import("@brainstorm/tools");
            resolveAskUser(askUserPrompt.options[0]?.value ?? "");
            setAskUserPrompt(null);
          }}
        />
      )}
      <Box flexDirection="column">
        <Box
          borderStyle="single"
          borderColor={isProcessing ? "gray" : "cyan"}
          paddingX={1}
        >
          <Text color={isProcessing ? "gray" : "cyan"} bold>
            {"> "}
          </Text>
          <TextInput
            value={input}
            onChange={(val) => {
              setInput(val);
              // Show autocomplete when typing a slash command
              setShowAutocomplete(
                val.startsWith("/") && val.length > 1 && !val.includes(" "),
              );
            }}
            onSubmit={(val) => {
              setShowAutocomplete(false);
              // Backslash continuation: \ at end of line adds newline instead of submitting
              if (val.endsWith("\\")) {
                setInput(val.slice(0, -1) + "\n");
                return;
              }
              handleSubmit(val);
            }}
            placeholder={
              isProcessing
                ? "Thinking..."
                : "Type a message... (/ commands, @file to include)"
            }
          />
        </Box>
        <Box paddingX={2}>
          <Text color="gray" dimColor>
            {isProcessing
              ? "Esc abort │ Shift+↑↓ scroll"
              : "/help │ Shift+Tab mode │ ↑↓ history │ Ctrl+D exit"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
