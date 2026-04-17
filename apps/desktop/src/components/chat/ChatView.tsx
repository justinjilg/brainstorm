import { useState, useRef, useCallback, useEffect, memo } from "react";
import {
  useChat,
  type ChatMessage,
  type ToolCallInfo,
} from "../../hooks/useChat";
import { Markdown } from "./Markdown";

interface ChatViewProps {
  conversationId: string | null;
  activeModelId?: string;
  activeRole?: string | null;
  activeSkills?: string[];
  onCostUpdate: (cost: number) => void;
  onModelUpdate: (model: string, provider: string) => void;
  onContextUpdate: (percent: number) => void;
  onNewConversation: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onModeChange: (...args: any[]) => void;
  onOpenPalette: () => void;
  onAgentEvent?: (event: any) => void;
}

export function ChatView({
  conversationId,
  activeModelId,
  activeRole,
  activeSkills,
  onCostUpdate,
  onModelUpdate,
  onContextUpdate,
  onNewConversation,
  onModeChange,
  onOpenPalette,
  onAgentEvent,
}: ChatViewProps) {
  // Forward every raw stream event up to App.tsx, which feeds the Trace
  // view's timeline. Pre-fix this prop was explicitly discarded
  // (`void _onAgentEvent`), making Trace mode permanently empty.
  //
  // Also thread conversationId so the hook rehydrates message history on
  // sidebar switches — without it, the transcript from the previous
  // conversation stayed visible under the new conversation's header.
  const {
    messages,
    streamingText,
    isProcessing,
    currentModel,
    currentProvider,
    sessionCost,
    activeTools,
    contextPercent,
    send,
    abort,
  } = useChat({ onEvent: onAgentEvent, conversationId });

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onContextUpdateRef = useRef(onContextUpdate);
  onContextUpdateRef.current = onContextUpdate;

  useEffect(() => {
    onCostUpdate(sessionCost);
  }, [sessionCost, onCostUpdate]);

  useEffect(() => {
    if (contextPercent > 0) {
      onContextUpdateRef.current(contextPercent);
    }
  }, [contextPercent]);

  useEffect(() => {
    if (currentModel && currentProvider) {
      onModelUpdate(currentModel, currentProvider);
    }
  }, [currentModel, currentProvider, onModelUpdate]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isProcessing) return;
    setInput("");
    send(text, {
      conversationId: conversationId ?? undefined,
      modelId: activeModelId,
      role: activeRole ?? undefined,
      activeSkills,
    });
  }, [
    input,
    isProcessing,
    send,
    conversationId,
    activeModelId,
    activeRole,
    activeSkills,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape" && isProcessing) {
        abort();
      }
    },
    [handleSend, isProcessing, abort],
  );

  // Auto-resize textarea
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    },
    [],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--ctp-base)]">
      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[720px] mx-auto px-6 py-8">
          {/* Empty state */}
          {messages.length === 0 && !isProcessing && (
            <div
              className="flex items-center justify-center min-h-[60vh]"
              data-testid="empty-state"
            >
              <div className="text-center animate-fade-in">
                <div
                  className="font-display mb-2"
                  style={{
                    fontSize: "var(--text-3xl)",
                    fontWeight: 460,
                    letterSpacing: "-0.02em",
                    color: "var(--bone)",
                    fontVariationSettings: "'opsz' 96, 'SOFT' 30",
                  }}
                >
                  Brainstorm
                </div>
                <div
                  className="mb-8 font-mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--bone-mute)",
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                  }}
                >
                  Multi-model agent orchestration
                </div>
                <div className="flex items-center justify-center gap-3">
                  {[
                    {
                      label: "New Chat",
                      hint: "⌘N",
                      icon: "+",
                      onClick: onNewConversation,
                    },
                    {
                      label: "Models",
                      hint: "⌘3",
                      icon: "◆",
                      onClick: () => onModeChange("models"),
                    },
                    {
                      label: "Commands",
                      hint: "⌘K",
                      icon: "⌘",
                      onClick: onOpenPalette,
                    },
                  ].map((action) => (
                    <button
                      key={action.label}
                      onClick={action.onClick}
                      data-testid={`action-${action.label.toLowerCase().replace(/\s+/g, "-")}`}
                      className="interactive flex flex-col items-center gap-1.5 px-5 py-3 rounded-xl"
                      style={{
                        border: "1px solid var(--border-default)",
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      <span
                        className="text-[var(--ctp-overlay1)]"
                        style={{ fontSize: "var(--text-lg)" }}
                      >
                        {action.icon}
                      </span>
                      <span className="text-[var(--ctp-subtext1)]">
                        {action.label}
                      </span>
                      <span
                        className="font-mono text-[var(--ctp-overlay0)]"
                        style={{ fontSize: "var(--text-2xs)" }}
                      >
                        {action.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          <div className="space-y-6">
            {messages.map((msg, i) => (
              <div
                key={msg.id}
                data-testid={`message-${msg.role}`}
                className="animate-fade-in"
                style={{ animationDelay: `${Math.min(i * 30, 200)}ms` }}
              >
                <MessageBubble message={msg} />
              </div>
            ))}

            {/* Streaming response */}
            {streamingText && (
              <div className="animate-fade-in" data-testid="message-streaming">
                {currentModel && (
                  <div
                    className="flex items-center gap-2 mb-2"
                    style={{ fontSize: "var(--text-2xs)" }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor: providerColor(currentProvider),
                      }}
                    />
                    <span className="text-[var(--ctp-overlay0)]">
                      {currentModel}
                    </span>
                  </div>
                )}
                <div style={{ fontSize: "var(--text-base)" }}>
                  <Markdown content={streamingText} />
                  <span className="animate-cursor-blink text-[var(--ctp-mauve)] ml-0.5">
                    ▎
                  </span>
                </div>
              </div>
            )}

            {/* Active tool calls */}
            {activeTools.length > 0 && (
              <div className="space-y-2 animate-fade-in">
                {activeTools.map((tool) => (
                  <ToolCallCard key={tool.id} tool={tool} />
                ))}
              </div>
            )}

            {/* Thinking indicator */}
            {isProcessing && !streamingText && activeTools.length === 0 && (
              <div
                className="flex items-center gap-2 animate-fade-in"
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ctp-overlay1)",
                }}
              >
                <span className="animate-pulse-glow">●</span>
                <span>Thinking...</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Floating composer */}
      <div className="px-4 pb-4 pt-2">
        <div
          className="max-w-[720px] mx-auto rounded-2xl overflow-hidden"
          style={{
            background: "var(--ctp-surface0)",
            boxShadow: "var(--shadow-md)",
            border: "1px solid var(--border-default)",
          }}
        >
          <div className="flex items-end gap-3 p-3">
            <textarea
              ref={inputRef}
              value={input}
              data-testid="chat-input"
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                isProcessing
                  ? "Agent is working... (Esc to abort)"
                  : "Type a message..."
              }
              rows={1}
              disabled={isProcessing}
              className="flex-1 bg-transparent resize-none outline-none placeholder:text-[var(--ctp-overlay0)] disabled:opacity-40"
              style={{
                color: "var(--ctp-text)",
                fontSize: "var(--text-base)",
                lineHeight: "1.5",
                minHeight: "24px",
                maxHeight: "200px",
                userSelect: "text",
                WebkitUserSelect: "text" as never,
              }}
            />
            {isProcessing ? (
              <button
                onClick={abort}
                data-testid="stop-button"
                className="interactive shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                style={{
                  background: "var(--ctp-red)",
                  color: "var(--ctp-crust)",
                }}
                title="Stop (Esc)"
              >
                ■
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                data-testid="send-button"
                className="interactive shrink-0 w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-20 disabled:cursor-not-allowed"
                style={{
                  background: input.trim()
                    ? "var(--ctp-mauve)"
                    : "var(--ctp-surface2)",
                  color: "var(--ctp-crust)",
                }}
                title="Send (Enter)"
              >
                ↑
              </button>
            )}
          </div>
          <div
            className="flex items-center justify-between px-4 pb-2"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            <span>Enter to send · Shift+Enter for new line</span>
            <span className="font-mono">⌘K commands</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function providerColor(provider: string | null): string {
  switch (provider) {
    case "anthropic":
      return "var(--color-anthropic)";
    case "openai":
      return "var(--color-openai)";
    case "google":
      return "var(--color-google)";
    case "deepseek":
      return "var(--color-deepseek)";
    default:
      return "var(--color-local)";
  }
}

const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: ChatMessage;
}) {
  const isUser = message.role === "user";
  const isRouting = message.role === "routing";
  const isSystem = message.role === "system";

  if (isRouting) {
    return (
      <div
        className="flex items-center gap-2"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
        }}
      >
        <span style={{ color: "var(--ctp-surface2)" }}>─</span>
        <span>{message.content}</span>
        <span style={{ color: "var(--ctp-surface2)" }}>─</span>
      </div>
    );
  }

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div
          className="px-4 py-2 rounded-xl max-w-[80%]"
          style={{
            background: "var(--glow-red)",
            border: "1px solid rgba(243, 139, 168, 0.2)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-red)",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[70%] rounded-2xl px-4 py-3"
          style={{
            background: "var(--ctp-surface0)",
            fontSize: "var(--text-base)",
            lineHeight: "1.5",
          }}
        >
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    );
  }

  // Assistant message — content-first, no bubble
  return (
    <div>
      {/* Model + cost header */}
      {message.model && (
        <div
          className="flex items-center gap-2 mb-2"
          style={{ fontSize: "var(--text-2xs)" }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: providerColor(message.provider ?? null) }}
          />
          <span className="text-[var(--ctp-overlay0)]">{message.model}</span>
          {message.cost != null && message.cost > 0 && (
            <>
              <span className="text-[var(--ctp-surface2)]">·</span>
              <span className="text-[var(--ctp-overlay0)] font-mono">
                ${message.cost.toFixed(4)}
              </span>
            </>
          )}
        </div>
      )}

      {/* Reasoning trace */}
      {message.reasoning && <ReasoningTrace text={message.reasoning} />}

      {/* Content — flows full-width, no bubble */}
      <div style={{ fontSize: "var(--text-base)", lineHeight: "1.6" }}>
        <Markdown content={message.content} />
        {message.aborted && (
          <span
            data-testid="assistant-aborted-marker"
            className="ml-2 font-mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-peach)",
            }}
            title="This response was stopped before it finished."
          >
            — stopped
          </span>
        )}
      </div>

      {/* Tool calls */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div
          className="mt-3 space-y-1.5 pt-3"
          style={{ borderTop: "1px solid var(--border-subtle)" }}
        >
          {message.toolCalls.map((tc) => (
            <div
              key={tc.id}
              className="flex items-center gap-2"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay1)",
              }}
            >
              <span
                style={{
                  color:
                    tc.status === "success"
                      ? "var(--ctp-green)"
                      : tc.status === "error"
                        ? "var(--ctp-red)"
                        : "var(--ctp-yellow)",
                }}
              >
                {tc.status === "success"
                  ? "✓"
                  : tc.status === "error"
                    ? "✗"
                    : "●"}
              </span>
              <span className="font-mono">{tc.name}</span>
              {tc.durationMs != null && (
                <span className="text-[var(--ctp-overlay0)]">
                  {tc.durationMs}ms
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function ToolCallCard({ tool }: { tool: ToolCallInfo }) {
  const isRunning = tool.status === "running";
  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 rounded-xl"
      style={{
        background: isRunning ? "var(--glow-mauve)" : "var(--ctp-surface0)",
        border: `1px solid ${isRunning ? "rgba(203, 166, 247, 0.15)" : "var(--border-subtle)"}`,
        fontSize: "var(--text-xs)",
      }}
    >
      <span
        className={isRunning ? "animate-pulse-glow" : ""}
        style={{
          color:
            tool.status === "running"
              ? "var(--ctp-mauve)"
              : tool.status === "success"
                ? "var(--ctp-green)"
                : "var(--ctp-red)",
        }}
      >
        {tool.status === "running"
          ? "●"
          : tool.status === "success"
            ? "✓"
            : "✗"}
      </span>
      <span className="font-mono text-[var(--ctp-subtext1)]">{tool.name}</span>
      {tool.durationMs != null && (
        <span className="text-[var(--ctp-overlay0)] font-mono">
          {tool.durationMs}ms
        </span>
      )}
    </div>
  );
}

function ReasoningTrace({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="interactive flex items-center gap-1.5 px-2 py-1 rounded-lg"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
        }}
      >
        <span
          className="transition-transform"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0)",
            transitionDuration: "var(--duration-fast)",
          }}
        >
          ▸
        </span>
        Reasoning
      </button>
      {expanded && (
        <div
          className="mt-1 pl-3 animate-fade-in"
          style={{
            borderLeft: "2px solid var(--ctp-surface1)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay1)",
            fontStyle: "italic",
            lineHeight: "1.5",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
