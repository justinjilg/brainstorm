import React, { useMemo } from "react";
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
  /** Maximum visible height in terminal rows. Messages auto-scroll to bottom. */
  maxHeight?: number;
  /** Scroll offset from bottom (0 = at bottom, positive = scrolled up). */
  scrollOffset?: number;
}

export function MessageList({
  messages,
  maxHeight,
  scrollOffset = 0,
}: MessageListProps) {
  // When maxHeight is provided, show only the tail of messages
  const visibleMessages = useMemo(() => {
    if (!maxHeight || messages.length <= 5) return messages;

    // Show last N messages that fit approximately
    // Rough heuristic: 2-3 lines per message on average
    const estimatedVisible = Math.max(5, Math.floor(maxHeight / 3));
    const startIdx = Math.max(
      0,
      messages.length - estimatedVisible - scrollOffset,
    );
    const endIdx = messages.length - scrollOffset;
    return messages.slice(startIdx, endIdx > 0 ? endIdx : undefined);
  }, [messages, maxHeight, scrollOffset]);

  const hiddenAbove = messages.length - visibleMessages.length - scrollOffset;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {hiddenAbove > 0 && (
        <Text color="gray" dimColor>
          {"  "}↑ {hiddenAbove} earlier message{hiddenAbove > 1 ? "s" : ""}{" "}
          (Shift+↑ to scroll)
        </Text>
      )}
      {visibleMessages.map((msg, i) => (
        <MessageBubble key={messages.indexOf(msg)} message={msg} />
      ))}
    </Box>
  );
}

const MessageBubble = React.memo(function MessageBubble({
  message,
}: {
  message: ChatMessage;
}) {
  switch (message.role) {
    case "user":
      return (
        <Box
          marginBottom={1}
          borderStyle="single"
          borderColor="blue"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          paddingLeft={1}
        >
          <Text color="blue" bold>
            you{" "}
          </Text>
          <Text>{message.content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="single"
          borderColor="green"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          paddingLeft={1}
        >
          <Box>
            <Text color="green" bold>
              brainstorm{" "}
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
          <Text color="gray" dimColor italic>
            ▸{" "}
            {message.content.length > 200
              ? message.content.slice(0, 200) + "..."
              : message.content}
          </Text>
        </Box>
      );

    case "routing": {
      // Determine icon based on content
      const content = message.content;
      let icon = "→";
      let color: string = "gray";
      if (content.startsWith("↻")) {
        icon = "";
        color = "yellow";
      } else if (content.startsWith("⚠")) {
        icon = "";
        color = "yellow";
      } else if (content.includes("tool:") || content.includes("subagent")) {
        icon = "⚙";
      } else if (content.includes("compacted")) {
        icon = "◇";
      } else if (content.includes("[bg]")) {
        icon = "◆";
      }

      return (
        <Box marginBottom={0} paddingLeft={2}>
          <Text color={color} dimColor>
            {icon ? `${icon} ` : ""}
            {content}
          </Text>
        </Box>
      );
    }

    default:
      return null;
  }
});
