import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { StatusBar } from './StatusBar.js';
import { MessageList, type ChatMessage } from './MessageList.js';
import { TaskList } from './TaskList.js';
import type { AgentEvent, AgentTask, RoutingDecision } from '@brainstorm/shared';

interface ChatAppProps {
  strategy: string;
  modelCount: { local: number; cloud: number };
  onSendMessage: (text: string) => AsyncGenerator<AgentEvent>;
}

export function ChatApp({ strategy, modelCount, onSendMessage }: ChatAppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState<string | undefined>(undefined);
  const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
  const [sessionCost, setSessionCost] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [tasks, setTasks] = useState<AgentTask[]>([]);

  const handleSubmit = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing) return;

    // Handle slash commands
    if (text.trim() === '/quit' || text.trim() === '/exit') {
      exit();
      return;
    }

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text.trim() }]);
    setIsProcessing(true);
    setStreamingText('');

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
          case 'tool-call-start':
            setMessages((prev) => [
              ...prev,
              { role: 'routing', content: `tool: ${event.toolName}` },
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
          case 'done':
            cost = event.totalCost;
            setSessionCost(event.totalCost);
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
  }, [isProcessing, onSendMessage, exit]);

  return (
    <Box flexDirection="column" height={process.stdout.rows || 24}>
      <StatusBar
        strategy={strategy}
        currentModel={currentModel}
        sessionCost={sessionCost}
        modelCount={modelCount}
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
