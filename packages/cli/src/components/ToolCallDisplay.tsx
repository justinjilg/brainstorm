import React from 'react';
import { Box, Text } from 'ink';

interface ToolCallDisplayProps {
  toolName: string;
  status: 'running' | 'done' | 'error';
  result?: string;
}

export function ToolCallDisplay({ toolName, status, result }: ToolCallDisplayProps) {
  const icon = status === 'running' ? '...' : status === 'done' ? 'done' : 'err';
  const color = status === 'running' ? 'yellow' : status === 'done' ? 'green' : 'red';

  return (
    <Box paddingLeft={2} marginBottom={0}>
      <Text color="gray">[</Text>
      <Text color={color}>{toolName}</Text>
      <Text color="gray">] {icon}</Text>
      {result && status === 'done' && (
        <Text color="gray" dimColor> {result.slice(0, 80)}</Text>
      )}
    </Box>
  );
}
