import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { StatusBar } from './StatusBar.js';
import { MessageList, type ChatMessage } from './MessageList.js';
import { TaskList } from './TaskList.js';
import { isSlashCommand, executeSlashCommand, type SlashContext } from '../commands/slash.js';
import { resolveKeyAction } from '../keybindings.js';
import { InputHistory } from '../input-history.js';
import type { AgentEvent, AgentTask, RoutingDecision } from '@brainstorm/shared';

interface ChatAppProps {
  strategy: string;
  modelCount: { local: number; cloud: number };
  onSendMessage: (text: string) => AsyncGenerator<AgentEvent>;
  onAbort?: () => void;
  /** Mutable context for slash commands — callbacks that affect session state */
  slashCallbacks?: {
    setModel?: (model: string) => void;
    setStrategy?: (strategy: string) => void;
    getStrategy?: () => string;
    setMode?: (mode: string) => void;
    getMode?: () => string;
    setOutputStyle?: (style: string) => void;
    getOutputStyle?: () => string;
    getBudget?: () => { remaining: number; limit: number } | null;
    compact?: () => Promise<void>;
  };
}

export function ChatApp({ strategy, modelCount, onSendMessage, onAbort, slashCallbacks }: ChatAppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState<string | undefined>(undefined);
  const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
  const [sessionCost, setSessionCost] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tokenCount, setTokenCount] = useState<{ input: number; output: number }>({ input: 0, output: 0 });
  const [history] = useState(() => new InputHistory());

  // Keybinding handler + input history navigation
  useInput((inputChar, key) => {
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
      case 'abort':
        if (isProcessing && onAbort) onAbort();
        break;
      case 'exit':
        exit();
        break;
      case 'clear-screen':
        process.stdout.write('\x1B[2J\x1B[0f');
        break;
      case 'clear-chat':
        setMessages([]);
        setStreamingText(undefined);
        break;
      case 'cycle-mode':
        // Mode cycling would be wired when mode state is lifted to this level
        break;
    }
  });

  const slashCtx: SlashContext = useMemo(() => ({
    getModel: () => currentModel,
    getSessionCost: () => sessionCost,
    getTokenCount: () => tokenCount,
    exit: () => exit(),
    clearHistory: () => {
      setMessages([]);
      setStreamingText(undefined);
    },
    setModel: slashCallbacks?.setModel,
    setStrategy: slashCallbacks?.setStrategy,
    getStrategy: slashCallbacks?.getStrategy,
    setMode: slashCallbacks?.setMode,
    getMode: slashCallbacks?.getMode,
    setOutputStyle: slashCallbacks?.setOutputStyle,
    getOutputStyle: slashCallbacks?.getOutputStyle,
    getBudget: slashCallbacks?.getBudget,
    compact: slashCallbacks?.compact,
  }), [currentModel, sessionCost, tokenCount, exit, slashCallbacks]);

  const handleSubmit = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing) return;
    history.push(text.trim());

    // Handle slash commands
    if (isSlashCommand(text)) {
      setInput('');
      const result = await executeSlashCommand(text, slashCtx);
      setMessages((prev) => [...prev, { role: 'routing', content: result }]);
      return;
    }

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text.trim() }]);
    setIsProcessing(true);
    setStreamingText('');
    setTasks([]);

    let fullResponse = '';
    let model: string | undefined;
    let cost = 0;

    try {
      for await (const event of onSendMessage(text.trim())) {
        switch (event.type) {
          case 'routing':
            model = event.decision.model.name;
            setCurrentModel(model);
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: `${event.decision.strategy} → ${model}` },
            ]);
            break;
          case 'text-delta':
            fullResponse += event.delta;
            setStreamingText(fullResponse);
            break;
          case 'reasoning':
            setMessages((prev) => [
              ...prev,
              { role: 'reasoning', content: event.content },
            ]);
            break;
          case 'tool-call-start':
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: `tool: ${event.toolName}` },
            ]);
            break;
          case 'compaction':
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: `context compacted — ${event.removed} messages summarized (${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} tokens)` },
            ]);
            break;
          case 'subagent-result':
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: `subagent [${event.subagentType}] → ${event.model} ($${event.cost.toFixed(4)}, ${event.toolCalls.length} tool calls)` },
            ]);
            break;
          case 'task-created':
            setTasks((prev) => [...prev, event.task]);
            break;
          case 'task-updated':
            setTasks((prev) =>
              prev.map((t) => (t.id === event.task.id ? event.task : t)),
            );
            break;
          case 'background-complete':
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: `[bg] ${event.taskId} completed (exit ${event.exitCode}): ${event.command.slice(0, 60)}` },
            ]);
            break;
          case 'interrupted':
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: 'interrupted' },
            ]);
            break;
          case 'done':
            cost = event.totalCost;
            setSessionCost(event.totalCost);
            if (event.totalTokens) setTokenCount(event.totalTokens);
            break;
          case 'error':
            setMessages((prev) => [
              ...prev,
              { role: 'assistant', content: `Error: ${event.error.message}`, model },
            ]);
            break;
        }
      }
    } catch (err: any) {
      fullResponse = `Error: ${err.message}`;
    }

    setStreamingText(undefined);
    if (fullResponse) {
      setMessages((prev) => [...prev, { role: 'assistant', content: fullResponse, model, cost }]);
    }
    setIsProcessing(false);
  }, [isProcessing, onSendMessage, exit, slashCtx]);

  return (
    <Box flexDirection="column" height={process.stdout.rows || 24}>
      <StatusBar
        strategy={strategy}
        currentModel={currentModel}
        sessionCost={sessionCost}
        modelCount={modelCount}
        tokenCount={tokenCount}
      />
      <MessageList messages={messages} streamingText={streamingText} />
      {tasks.length > 0 && <TaskList tasks={tasks} />}
      <Box borderStyle="single" borderColor={isProcessing ? 'gray' : 'cyan'} paddingX={1}>
        <Text color={isProcessing ? 'gray' : 'cyan'} bold>{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={isProcessing ? 'Thinking...' : 'Type a message...'}
        />
      </Box>
    </Box>
  );
}
