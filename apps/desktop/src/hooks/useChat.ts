/**
 * useChat — React hook for SSE-streamed chat with BrainstormServer.
 *
 * Manages message history, streaming state, tool calls, and cost tracking.
 * Consumes AgentEvent stream from POST /api/v1/chat/stream.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { streamChat, abortChat, request } from "../lib/ipc-client";
import type { ChatMessage, ToolCallInfo } from "./chat-types.js";
import { finalizeAssistantMessage } from "./finalize-turn.js";

export type { ChatMessage, ToolCallInfo };

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
  /**
   * Rehydrate the message list from a conversation's history on the backend.
   * Pre-fix: switching conversations in the sidebar left the local messages
   * state intact — the user saw the previous conversation's bubbles under
   * the new conversation's header. Call this when activeConversationId
   * changes.
   */
  loadConversation: (sessionId: string | null) => Promise<void>;
}

export interface UseChatOptions {
  /**
   * Fires on every raw event received during streaming (routing, text-delta,
   * tool-call-start, tool-result, cost, done, error, ...). Used by
   * App.tsx to populate the Trace view. The hook itself still handles the
   * event internally; this is observability-only.
   */
  onEvent?: (event: any) => void;
  /**
   * The session/conversation id whose history the view should reflect.
   * When this changes, the hook rehydrates `messages` from the backend's
   * message repository via conversations.messages. Null means "fresh
   * conversation — no prior history to load."
   */
  conversationId?: string | null;
}

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { onEvent, conversationId } = options;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentProvider, setCurrentProvider] = useState<string | null>(null);
  const [sessionCost, setSessionCost] = useState(0);
  const [activeTools, setActiveTools] = useState<ToolCallInfo[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const loadConversationRef = useRef<
    ((sessionId: string | null) => Promise<void>) | null
  >(null);
  // Mirrors `isProcessing` but is readable synchronously inside `send`
  // before React has flushed the setIsProcessing(true) re-render.
  // Without this, two back-to-back synchronous calls (rapid Enter
  // keypress, or a button click + Enter race) both see the stale
  // closure-captured `isProcessing=false` and kick off two parallel
  // turns — the second one blows away the first's streaming text and
  // only the second's assistantMsg lands in the transcript. Using a
  // ref as the guard closes the window before the state flush.
  const isProcessingRef = useRef(false);
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
      // Ref-based guard — see isProcessingRef declaration for the
      // race it closes. Always flip the ref before any async work,
      // and always reset it in the shared cleanup block below.
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

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
      let aborted = false;
      // Flips true if the backend emits an "error" event mid-stream.
      // Without this flag, a provider error that arrived AFTER some
      // text had already been streamed would finalize the assistant
      // message as if it were complete — the user would see a
      // truncated reply with no indication it had been cut short. We
      // reuse the aborted-marker UI to flag it, since the user-visible
      // shape is identical: partial content with a warning.
      let backendErrored = false;
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
            // Observability hook: forward every event to the caller before
            // we handle it internally, so App.tsx can feed the Trace view.
            // Errors in onEvent must never break the stream.
            try {
              onEvent?.(event);
            } catch {
              /* ignore observer errors */
            }
            switch (event.type) {
              case "session":
                sessionIdRef.current = (event.data?.sessionId as string) ?? "";
                break;

              case "routing": {
                const dataModel = event.data?.model as
                  | Record<string, unknown>
                  | undefined;
                model =
                  event.model?.name ??
                  event.modelName ??
                  (dataModel?.name as string | undefined);
                provider =
                  event.model?.provider ??
                  event.provider ??
                  (dataModel?.provider as string | undefined);
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
                reasoning =
                  event.text ??
                  event.content ??
                  (event.data?.text as string | undefined);
                break;

              case "text-delta": {
                const delta =
                  event.delta ??
                  event.text ??
                  (event.data?.delta as string | undefined) ??
                  "";
                accumulatedText += delta;
                setStreamingText(accumulatedText);
                break;
              }

              case "tool-call-start": {
                const tool: ToolCallInfo = {
                  id: event.toolCallId ?? `tc-${Date.now()}`,
                  name: event.toolName ?? event.name ?? "unknown",
                  status: "running",
                  input: event.input as Record<string, unknown> | undefined,
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
                const percent =
                  event.percent ??
                  (event.data?.percent as number | undefined) ??
                  0;
                setContextPercent(percent);
                break;
              }

              case "error": {
                backendErrored = true;
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
        if (
          err instanceof Error &&
          (err.name === "AbortError" || controller.signal.aborted)
        ) {
          aborted = true;
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

      // Finalize via the pure helper so the protocol-tier trap can pin
      // the decision matrix (abort, backend-error, both) without having
      // to mount the React hook under jsdom.
      const assistantMsg = finalizeAssistantMessage({
        accumulatedText,
        aborted,
        backendErrored,
        model,
        provider,
        turnCost,
        toolCalls,
        reasoning,
      });
      if (assistantMsg) {
        setMessages((prev) => [...prev, assistantMsg]);
      }

      setStreamingText("");
      setIsProcessing(false);
      isProcessingRef.current = false;
      setActiveTools([]);
      abortRef.current = null;
    },
    // Only `onEvent` actually needs to be in deps — `isProcessing` is
    // now a ref, and `sessionCost` was only here by accident (the body
    // never reads it, so its presence just churned `send`'s identity
    // on every cost tick and forced memoized parents to re-render).
    [onEvent],
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

  // Auto-load when the caller's conversationId changes. The imperative
  // loadConversation export below is kept for code that needs to trigger
  // a reload explicitly (e.g. after a manual refresh button).
  useEffect(() => {
    if (conversationId === undefined) return; // hook called without option
    loadConversationRef.current?.(conversationId);
    // loadConversation is stable (useCallback with no deps), so no need to
    // depend on it here — the ref keeps us safe from stale closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const loadConversation = useCallback(async (sessionId: string | null) => {
    // Null sessionId means "no conversation selected" — reset to an empty
    // chat. Don't touch model/provider/cost; those belong to the active
    // turn, not the conversation.
    if (!sessionId) {
      setMessages([]);
      setStreamingText("");
      sessionIdRef.current = null;
      return;
    }
    try {
      const prior = await request<
        Array<{
          id: string;
          role: "user" | "assistant" | "system" | "tool";
          content: string;
          modelId?: string;
          timestamp: number;
        }>
      >("conversations.messages", { sessionId });
      // Map DB rows to ChatMessage. Drop `tool` rows — they don't belong in
      // the linear chat transcript (tool calls render inline on the owning
      // assistant message, not as standalone bubbles).
      const rehydrated: ChatMessage[] = prior
        .filter((m) => m.role !== "tool")
        .map((m) => ({
          id: m.id,
          role: m.role as ChatMessage["role"],
          content: m.content,
          model: m.modelId,
          timestamp: m.timestamp * 1000, // DB stores seconds; UI uses ms.
        }));
      setMessages(rehydrated);
      setStreamingText("");
      sessionIdRef.current = sessionId;
    } catch {
      // Failed to rehydrate — leave the UI in its current state rather than
      // wiping what the user already has.
    }
  }, []);

  // Keep the ref pointed at the current loadConversation so the useEffect
  // above can call it without a useCallback dep cycle.
  useEffect(() => {
    loadConversationRef.current = loadConversation;
  }, [loadConversation]);

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
    loadConversation,
  };
}
