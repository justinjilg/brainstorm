import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { MarkdownRenderer } from './MarkdownRenderer.js';

interface StreamingMessageProps {
  /** Text accumulated so far (grows as deltas arrive) */
  content: string;
  /** Whether the message is still streaming */
  isStreaming: boolean;
  /** Agent/role name to display */
  sender?: string;
  /** Model name */
  model?: string;
}

export function StreamingMessage({ content, isStreaming, sender, model }: StreamingMessageProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="green" bold>{sender ?? 'brainstorm'} </Text>
        {model && <Text color="gray" dimColor>[{model}] </Text>}
      </Box>
      <Box paddingLeft={0}>
        {content ? (
          <MarkdownRenderer content={content} />
        ) : (
          isStreaming && <Text color="gray">thinking...</Text>
        )}
        {isStreaming && content && <Text color="cyan" bold>{'_'}</Text>}
      </Box>
    </Box>
  );
}
