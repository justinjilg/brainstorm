import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  strategy: string;
  currentModel?: string;
  sessionCost: number;
  modelCount: { local: number; cloud: number };
}

export function StatusBar({ strategy, currentModel, sessionCost, modelCount }: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="row" justifyContent="space-between">
      <Text>
        <Text color="cyan" bold>brainstorm</Text>
        <Text color="gray"> | </Text>
        <Text color="yellow">{strategy}</Text>
      </Text>
      <Text>
        {currentModel && (
          <>
            <Text color="green">{currentModel}</Text>
            <Text color="gray"> | </Text>
          </>
        )}
        <Text color="gray">{modelCount.local} local, {modelCount.cloud} cloud</Text>
        <Text color="gray"> | </Text>
        <Text color={sessionCost > 0 ? 'yellow' : 'green'}>${sessionCost.toFixed(4)}</Text>
      </Text>
    </Box>
  );
}
