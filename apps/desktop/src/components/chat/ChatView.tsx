import { useState, useRef, useCallback } from "react";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  provider?: string;
  cost?: number;
  timestamp: number;
}

interface ChatViewProps {
  conversationId: string | null;
  detailOpen: boolean;
  onDetailToggle: () => void;
  onCostUpdate: (cost: number) => void;
  onModelUpdate: (model: string, provider: string) => void;
  onContextUpdate: (percent: number) => void;
}

export function ChatView({
  onCostUpdate: _onCostUpdate,
  onModelUpdate: _onModelUpdate,
  onContextUpdate: _onContextUpdate,
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isProcessing) return;

    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsProcessing(true);

    // TODO: Connect to BrainstormServer SSE endpoint
    // For now, simulate a response
    setTimeout(() => {
      const assistantMessage: Message = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: `Received: "${text}"\n\nBrainstormServer connection coming in Phase 1B. This will stream via SSE from the Node.js sidecar.`,
        model: "Claude Opus 4.6",
        provider: "anthropic",
        cost: 0.0,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setIsProcessing(false);
    }, 500);
  }, [input, isProcessing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <div className="text-4xl mb-4">⚡</div>
              <div className="text-lg font-medium text-[var(--ctp-text)] mb-2">
                Brainstorm Desktop
              </div>
              <div className="text-sm text-[var(--ctp-overlay1)] leading-relaxed">
                Multi-model agent orchestration. Switch roles, route across
                providers, track cost in real-time.
              </div>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isProcessing && (
          <div className="flex items-center gap-2 text-sm text-[var(--ctp-overlay1)]">
            <span className="animate-pulse">●</span>
            <span>Thinking...</span>
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
            placeholder="Send a message..."
            rows={1}
            className="flex-1 bg-transparent text-[var(--ctp-text)] text-sm resize-none outline-none placeholder:text-[var(--ctp-overlay0)] min-h-[24px] max-h-[120px]"
            style={{ userSelect: "text", WebkitUserSelect: "text" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isProcessing}
            className="px-3 py-1 rounded-lg text-xs font-medium transition-colors bg-[var(--ctp-mauve)] text-[var(--ctp-crust)] hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-[var(--ctp-overlay0)]">
          <span>Enter to send · Shift+Enter for new line · / for commands</span>
          <span>⌘D detail panel</span>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

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
                backgroundColor:
                  message.provider === "anthropic"
                    ? "var(--color-anthropic)"
                    : message.provider === "openai"
                      ? "var(--color-openai)"
                      : "var(--color-local)",
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
        <div className="whitespace-pre-wrap">{message.content}</div>
      </div>
    </div>
  );
}
