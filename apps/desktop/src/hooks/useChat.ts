/**
 * useChat — React hook for SSE-streamed chat with BrainstormServer.
 *
 * Manages message history, streaming state, tool calls, and cost tracking.
 * Consumes AgentEvent stream from POST /api/v1/chat/stream.
 */

import { useState, useCallback, useRef } from "react";
import { getClient } from "../lib/api-client";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "routing";
  content: string;
  model?: string;
  provider?: string;
  cost?: number;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  reasoning?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  durationMs?: number;
  input?: Record<string, unknown>;
  output?: unknown;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  streamingText: string;
  isProcessing: boolean;
  currentModel: string | null;
  currentProvider: string | null;
  sessionCost: number;
  activeTools: ToolCallInfo[];
  send: (
    text: string,
    opts?: { modelId?: string; conversationId?: string },
  ) => void;
  abort: () => void;
  clear: () => void;
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentProvider, setCurrentProvider] = useState<string | null>(null);
  const [sessionCost, setSessionCost] = useState(0);
  const [activeTools, setActiveTools] = useState<ToolCallInfo[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const send = useCallback(
    async (
      text: string,
      opts?: { modelId?: string; conversationId?: string },
    ) => {
      if (isProcessing) return;

      // Add user message
      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}-user`,
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreamingText("");
      setIsProcessing(true);
      setActiveTools([]);

      const controller = new AbortController();
      abortRef.current = controller;

      const client = getClient();
      let accumulatedText = "";
      let turnCost = 0;
      let model: string | undefined;
      let provider: string | undefined;
      let reasoning: string | undefined;
      const toolCalls: ToolCallInfo[] = [];

      try {
        for await (const event of client.chatStream(
          {
            message: text,
            sessionId: sessionIdRef.current ?? undefined,
            conversationId: opts?.conversationId,
            modelId: opts?.modelId,
          },
          controller.signal,
        )) {
          switch (event.type) {
            case "session":
              sessionIdRef.current = event.sessionId as string;
              break;

            case "routing": {
              model = (event as any).model?.name ?? (event as any).modelName;
              provider =
                (event as any).model?.provider ?? (event as any).provider;
              if (model) setCurrentModel(model);
              if (provider) setCurrentProvider(provider);

              // Add routing message
              const routeMsg: ChatMessage = {
                id: `msg-${Date.now()}-route`,
                role: "routing",
                content: `→ ${model} via ${(event as any).strategy ?? "auto"}`,
                timestamp: Date.now(),
              };
              setMessages((prev) => [...prev, routeMsg]);
              break;
            }

            case "thinking":
              reasoning = (event as any).text ?? (event as any).content;
              break;

            case "text-delta": {
              const delta = (event as any).delta ?? (event as any).text ?? "";
              accumulatedText += delta;
              setStreamingText(accumulatedText);
              break;
            }

            case "tool-call-start": {
              const tool: ToolCallInfo = {
                id: (event as any).toolCallId ?? `tc-${Date.now()}`,
                name:
                  (event as any).toolName ?? (event as any).name ?? "unknown",
                status: "running",
                input: (event as any).input,
              };
              toolCalls.push(tool);
              setActiveTools([...toolCalls]);
              break;
            }

            case "tool-result": {
              const tcId = (event as any).toolCallId ?? (event as any).id;
              const tc = toolCalls.find((t) => t.id === tcId);
              if (tc) {
                tc.status = (event as any).ok === false ? "error" : "success";
                tc.durationMs = (event as any).durationMs;
                tc.output = (event as any).output;
                setActiveTools([...toolCalls]);
              }
              break;
            }

            case "cost": {
              turnCost = (event as any).totalCost ?? (event as any).cost ?? 0;
              setSessionCost(turnCost);
              break;
            }

            case "done": {
              turnCost =
                (event as any).totalCost ?? (event as any).cost ?? turnCost;
              setSessionCost(turnCost);
              break;
            }

            case "error": {
              const errMsg: ChatMessage = {
                id: `msg-${Date.now()}-err`,
                role: "system",
                content: `Error: ${(event as any).error ?? (event as any).message ?? "Unknown error"}`,
                timestamp: Date.now(),
              };
              setMessages((prev) => [...prev, errMsg]);
              break;
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // User aborted — that's fine
        } else {
          const errMsg: ChatMessage = {
            id: `msg-${Date.now()}-err`,
            role: "system",
            content: `Connection error: ${err instanceof Error ? err.message : "Unknown error"}. Is BrainstormServer running on port 3100?`,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, errMsg]);
        }
      }

      // Finalize assistant message
      if (accumulatedText) {
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}-assistant`,
          role: "assistant",
          content: accumulatedText,
          model,
          provider,
          cost: turnCost > 0 ? turnCost - (sessionCost - turnCost) : undefined,
          timestamp: Date.now(),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }

      setStreamingText("");
      setIsProcessing(false);
      setActiveTools([]);
      abortRef.current = null;
    },
    [isProcessing, sessionCost],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setStreamingText("");
    sessionIdRef.current = null;
    setSessionCost(0);
  }, []);

  return {
    messages,
    streamingText,
    isProcessing,
    currentModel,
    currentProvider,
    sessionCost,
    activeTools,
    send,
    abort,
    clear,
  };
}
