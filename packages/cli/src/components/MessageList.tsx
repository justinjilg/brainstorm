import React from "react";
import { Box, Text } from "ink";
import { MarkdownRenderer } from "./MarkdownRenderer.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "routing" | "reasoning";
  content: string;
  model?: string;
  cost?: number;
}

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}
    </Box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text color="blue" bold>
            {"you "}
          </Text>
          <Text>{message.content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="green" bold>
              {"brainstorm "}
            </Text>
            {message.model && (
              <Text color="gray" dimColor>
                [{message.model}]{" "}
              </Text>
            )}
          </Box>
          <Box paddingLeft={0}>
            <MarkdownRenderer content={message.content} />
          </Box>
          {message.cost !== undefined && message.cost > 0 && (
            <Text color="gray" dimColor>
              {" "}
              ${message.cost.toFixed(4)}
            </Text>
          )}
        </Box>
      );
    case "reasoning":
      return (
        <Box marginBottom={0} paddingLeft={2}>
          <Text color="gray" dimColor>
            {"▸ "}
          </Text>
          <Text color="gray" dimColor>
            {message.content.length > 200
              ? message.content.slice(0, 200) + "..."
              : message.content}
          </Text>
        </Box>
      );
    case "routing":
      return (
        <Box marginBottom={0}>
          <Text color="gray" dimColor>
            {" "}
            [{message.content}]
          </Text>
        </Box>
      );
    default:
      return null;
  }
}
