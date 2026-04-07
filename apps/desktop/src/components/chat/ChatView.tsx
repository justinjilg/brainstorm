import { useState, useRef, useCallback, useEffect } from "react";
import {
  useChat,
  type ChatMessage,
  type ToolCallInfo,
} from "../../hooks/useChat";

interface ChatViewProps {
  conversationId: string | null;
  detailOpen: boolean;
  onDetailToggle: () => void;
  onCostUpdate: (cost: number) => void;
  onModelUpdate: (model: string, provider: string) => void;
  onContextUpdate: (percent: number) => void;
}

export function ChatView({
  conversationId,
  onCostUpdate,
  onModelUpdate,
}: ChatViewProps) {
  const {
    messages,
    streamingText,
    isProcessing,
    currentModel,
    currentProvider,
    sessionCost,
    activeTools,
    send,
    abort,
  } = useChat();

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Propagate state to parent
  useEffect(() => {
    onCostUpdate(sessionCost);
  }, [sessionCost, onCostUpdate]);

  useEffect(() => {
    if (currentModel && currentProvider) {
      onModelUpdate(currentModel, currentProvider);
    }
  }, [currentModel, currentProvider, onModelUpdate]);

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isProcessing) return;
    setInput("");
    send(text, { conversationId: conversationId ?? undefined });
  }, [input, isProcessing, send, conversationId]);

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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && !isProcessing && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <div className="text-4xl mb-4">⚡</div>
              <div className="text-lg font-medium text-[var(--ctp-text)] mb-2">
                Brainstorm Desktop
              </div>
              <div className="text-sm text-[var(--ctp-overlay1)] leading-relaxed mb-4">
                Multi-model agent orchestration. Switch roles, route across
                providers, track costs in real-time.
              </div>
              <div className="text-xs text-[var(--ctp-overlay0)]">
                Ensure BrainstormServer is running on port 3100
              </div>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming response */}
        {streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed bg-[var(--ctp-surface0)] text-[var(--ctp-text)]">
              {currentModel && (
                <div className="flex items-center gap-1.5 mb-1 text-[10px]">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      backgroundColor: providerColor(currentProvider),
                    }}
                  />
                  <span className="text-[var(--ctp-overlay1)]">
                    {currentModel}
                  </span>
                </div>
              )}
              <div className="whitespace-pre-wrap">
                {streamingText}
                <span className="animate-pulse text-[var(--ctp-mauve)]">▌</span>
              </div>
            </div>
          </div>
        )}

        {/* Active tool calls */}
        {activeTools.length > 0 && (
          <div className="space-y-1 ml-2">
            {activeTools.map((tool) => (
              <ToolCallCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}

        {/* Processing indicator (no streaming text yet) */}
        {isProcessing && !streamingText && activeTools.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-[var(--ctp-overlay1)] ml-2">
            <span className="animate-pulse">●</span>
            <span>Connecting to model...</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-[var(--ctp-surface0)] p-3 bg-[var(--ctp-mantle)]">
        <div className="flex items-end gap-2 bg-[var(--ctp-surface0)] rounded-xl p-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isProcessing
                ? "Agent is working... (Esc to abort)"
                : "Send a message..."
            }
            rows={1}
            disabled={isProcessing}
            className="flex-1 bg-transparent text-[var(--ctp-text)] text-sm resize-none outline-none placeholder:text-[var(--ctp-overlay0)] min-h-[24px] max-h-[120px] disabled:opacity-50"
            style={{ userSelect: "text", WebkitUserSelect: "text" }}
          />
          {isProcessing ? (
            <button
              onClick={abort}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-[var(--ctp-red)] text-[var(--ctp-crust)] hover:brightness-110"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-3 py-1 rounded-lg text-xs font-medium transition-colors bg-[var(--ctp-mauve)] text-[var(--ctp-crust)] hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-[var(--ctp-overlay0)]">
          <span>Enter to send · Shift+Enter for new line · Esc to abort</span>
          <span>⌘D detail · ⌘B sidebar</span>
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isRouting = message.role === "routing";
  const isSystem = message.role === "system";

  if (isRouting) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-[var(--ctp-overlay0)] ml-2">
        <span>{message.content}</span>
      </div>
    );
  }

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="px-3 py-1.5 rounded-lg text-xs bg-[var(--ctp-red)]/10 text-[var(--ctp-red)] max-w-[80%]">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-[var(--ctp-mauve)] text-[var(--ctp-crust)]"
            : "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
        }`}
      >
        {!isUser && message.model && (
          <div className="flex items-center gap-1.5 mb-1 text-[10px]">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                backgroundColor: providerColor(message.provider ?? null),
              }}
            />
            <span className="text-[var(--ctp-overlay1)]">{message.model}</span>
            {message.cost != null && message.cost > 0 && (
              <span className="text-[var(--ctp-overlay0)]">
                ${message.cost.toFixed(4)}
              </span>
            )}
          </div>
        )}

        {/* Reasoning trace (expandable) */}
        {message.reasoning && <ReasoningTrace text={message.reasoning} />}

        <div className="whitespace-pre-wrap">{message.content}</div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
            {message.toolCalls.map((tc) => (
              <div
                key={tc.id}
                className="flex items-center gap-1.5 text-[10px] text-[var(--ctp-overlay1)]"
              >
                <span>
                  {tc.status === "success"
                    ? "✓"
                    : tc.status === "error"
                      ? "✗"
                      : "●"}
                </span>
                <span>{tc.name}</span>
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
    </div>
  );
}

function ToolCallCard({ tool }: { tool: ToolCallInfo }) {
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--ctp-overlay1)] bg-[var(--ctp-surface0)] rounded-lg px-3 py-1.5">
      <span
        className={
          tool.status === "running"
            ? "animate-pulse text-[var(--ctp-yellow)]"
            : tool.status === "success"
              ? "text-[var(--ctp-green)]"
              : "text-[var(--ctp-red)]"
        }
      >
        {tool.status === "running"
          ? "●"
          : tool.status === "success"
            ? "✓"
            : "✗"}
      </span>
      <span className="font-mono">{tool.name}</span>
      {tool.durationMs != null && (
        <span className="text-[var(--ctp-overlay0)]">{tool.durationMs}ms</span>
      )}
    </div>
  );
}

function ReasoningTrace({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-[var(--ctp-overlay0)] hover:text-[var(--ctp-overlay1)]"
      >
        {expanded ? "▾" : "▸"} Reasoning
      </button>
      {expanded && (
        <div className="text-[11px] text-[var(--ctp-overlay1)] italic mt-1 pl-2 border-l border-[var(--ctp-surface1)]">
          {text}
        </div>
      )}
    </div>
  );
}
