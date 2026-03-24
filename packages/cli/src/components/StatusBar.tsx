import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionMode } from '@brainstorm/shared';

interface StatusBarProps {
  strategy: string;
  currentModel?: string;
  sessionCost: number;
  modelCount: { local: number; cloud: number };
  permissionMode?: PermissionMode;
}

const MODE_LABELS: Record<PermissionMode, { label: string; color: string }> = {
  auto: { label: 'AUTO', color: 'green' },
  confirm: { label: 'CONFIRM', color: 'yellow' },
  plan: { label: 'PLAN', color: 'cyan' },
};

export function StatusBar({ strategy, currentModel, sessionCost, modelCount, permissionMode = 'confirm' }: StatusBarProps) {
  const mode = MODE_LABELS[permissionMode];
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="row" justifyContent="space-between">
      <Text>
        <Text color="cyan" bold>brainstorm</Text>
        <Text color="gray"> | </Text>
        <Text color="yellow">{strategy}</Text>
        <Text color="gray"> | </Text>
        <Text color={mode.color}>{mode.label}</Text>
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
