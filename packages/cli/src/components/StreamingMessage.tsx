import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { MarkdownRenderer } from "./MarkdownRenderer.js";

const PHASE_LABELS: Record<string, string> = {
  classifying: "Analyzing",
  routing: "Selecting model",
  connecting: "Connecting",
  streaming: "Streaming",
};

interface StreamingMessageProps {
  /** Text accumulated so far (grows as deltas arrive). */
  content: string;
  /** Whether the message is still streaming. */
  isStreaming: boolean;
  /** Current thinking phase (classifying, routing, connecting, streaming). */
  phase?: string;
  /** Active model name. */
  model?: string;
}

export const StreamingMessage = React.memo(function StreamingMessage({
  content,
  isStreaming,
  phase,
  model,
}: StreamingMessageProps) {
  // No content yet — show spinner with phase
  if (!content && isStreaming) {
    const label = phase ? (PHASE_LABELS[phase] ?? phase) : "Thinking";
    return (
      <Box paddingLeft={1}>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="gray" dimColor>
          {" "}
          {label}
          {model ? ` · ${model}` : ""}
          {"..."}
        </Text>
      </Box>
    );
  }

  // Content is streaming — render only the tail to prevent Ink buffer overflow
  if (content && isStreaming) {
    // Truncate to last ~2000 chars for rendering performance
    const MAX_STREAM_RENDER = 2000;
    const truncated = content.length > MAX_STREAM_RENDER;
    let visibleContent = truncated
      ? content.slice(-MAX_STREAM_RENDER)
      : content;

    // Ensure no unclosed code blocks (causes markdown parser hangs)
    if (truncated) {
      const backtickCount = (visibleContent.match(/```/g) || []).length;
      if (backtickCount % 2 === 1) {
        const lastOpen = visibleContent.lastIndexOf("```");
        if (lastOpen > 100) visibleContent = visibleContent.slice(0, lastOpen);
      }
    }

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="green" bold>
            {"brainstorm "}
          </Text>
          {model && (
            <Text color="gray" dimColor>
              [{model}]{" "}
            </Text>
          )}
          {truncated && (
            <Text color="gray" dimColor>
              ({content.length} chars, showing tail)
            </Text>
          )}
        </Box>
        <Box paddingLeft={0}>
          <MarkdownRenderer content={visibleContent} />
          <Text color="cyan" bold>
            {"▌"}
          </Text>
        </Box>
      </Box>
    );
  }

  return null;
});
