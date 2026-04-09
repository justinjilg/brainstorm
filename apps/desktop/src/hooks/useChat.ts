/**
 * useChat — React hook for SSE-streamed chat with BrainstormServer.
 *
 * Manages message history, streaming state, tool calls, and cost tracking.
 * Consumes AgentEvent stream from POST /api/v1/chat/stream.
 */

import { useState, useCallback, useRef } from "react";
import { streamChat, abortChat } from "../lib/ipc-client";

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
  contextPercent: number;
  activeTools: ToolCallInfo[];
  send: (
    text: string,
    opts?: {
      modelId?: string;
      conversationId?: string;
      role?: string;
      activeSkills?: string[];
    },
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
  const [contextPercent, setContextPercent] = useState(0);

  const send = useCallback(
    async (
      text: string,
      opts?: {
        modelId?: string;
        conversationId?: string;
        role?: string;
        activeSkills?: string[];
      },
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

      let accumulatedText = "";
      let turnCost = 0;
      let model: string | undefined;
      let provider: string | undefined;
      let reasoning: string | undefined;
      const toolCalls: ToolCallInfo[] = [];

      try {
        await streamChat(
          {
            message: text,
            conversationId: opts?.conversationId,
            modelId: opts?.modelId,
            role: opts?.role,
            activeSkills: opts?.activeSkills,
          },
          (event) => {
            switch (event.type) {
              case "session":
                sessionIdRef.current = (event.data?.sessionId as string) ?? "";
                break;

              case "routing": {
                model =
                  event.model?.name ??
                  event.modelName ??
                  event.data?.model?.name;
                provider =
                  event.model?.provider ??
                  event.provider ??
                  event.data?.model?.provider;
                if (model) setCurrentModel(model);
                if (provider) setCurrentProvider(provider);

                const routeMsg: ChatMessage = {
                  id: `msg-${Date.now()}-route`,
                  role: "routing",
                  content: `→ ${model} via ${event.strategy ?? event.data?.strategy ?? "auto"}`,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, routeMsg]);
                break;
              }

              case "thinking":
                reasoning = event.text ?? event.content ?? event.data?.text;
                break;

              case "text-delta": {
                const delta =
                  event.delta ?? event.text ?? event.data?.delta ?? "";
                accumulatedText += delta;
                setStreamingText(accumulatedText);
                break;
              }

              case "tool-call-start": {
                const tool: ToolCallInfo = {
                  id: event.toolCallId ?? `tc-${Date.now()}`,
                  name: event.toolName ?? event.name ?? "unknown",
                  status: "running",
                  input: event.input,
                };
                toolCalls.push(tool);
                setActiveTools([...toolCalls]);
                break;
              }

              case "tool-result": {
                const tcId = event.toolCallId ?? event.id;
                const tc = toolCalls.find((t) => t.id === tcId);
                if (tc) {
                  tc.status = event.ok === false ? "error" : "success";
                  tc.durationMs = event.durationMs;
                  tc.output = event.output;
                  setActiveTools([...toolCalls]);
                }
                break;
              }

              case "cost": {
                turnCost = event.totalCost ?? event.cost ?? 0;
                setSessionCost(turnCost);
                break;
              }

              case "done": {
                turnCost = event.totalCost ?? event.cost ?? turnCost;
                setSessionCost(turnCost);
                break;
              }

              case "context-budget": {
                const percent = event.percent ?? event.data?.percent ?? 0;
                setContextPercent(percent);
                break;
              }

              case "error": {
                const errMsg: ChatMessage = {
                  id: `msg-${Date.now()}-err`,
                  role: "system",
                  content: `Error: ${event.error ?? event.message ?? "Unknown error"}`,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, errMsg]);
                break;
              }
            }
          },
          controller.signal,
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // User aborted
        } else {
          const errMsg: ChatMessage = {
            id: `msg-${Date.now()}-err`,
            role: "system",
            content: `Connection error: ${err instanceof Error ? err.message : "Unknown error"}`,
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
          cost: turnCost > 0 ? turnCost : undefined,
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
    abortChat().catch(() => {});
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
    contextPercent,
    activeTools,
    send,
    abort,
    clear,
  };
}
