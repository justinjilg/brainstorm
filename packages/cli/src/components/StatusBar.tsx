import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionMode } from '@brainstorm/shared';

interface StatusBarProps {
  strategy: string;
  currentModel?: string;
  sessionCost: number;
  modelCount: { local: number; cloud: number };
  permissionMode?: PermissionMode;
  tokenCount?: { input: number; output: number };
  sessionId?: string;
}

const MODE_LABELS: Record<PermissionMode, { label: string; color: string }> = {
  auto: { label: 'auto', color: 'green' },
  confirm: { label: 'confirm', color: 'yellow' },
  plan: { label: 'plan', color: 'cyan' },
};

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function StatusBar({
  strategy,
  currentModel,
  sessionCost,
  modelCount,
  permissionMode = 'confirm',
  tokenCount,
  sessionId,
}: StatusBarProps) {
  const mode = MODE_LABELS[permissionMode];
  const totalTokens = tokenCount ? tokenCount.input + tokenCount.output : 0;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="row" justifyContent="space-between">
      <Text>
        <Text color={mode.color} bold>{mode.label}</Text>
        <Text color="gray"> │ </Text>
        <Text color="green">{currentModel ?? `${strategy} routing`}</Text>
        {totalTokens > 0 && (
          <>
            <Text color="gray"> │ </Text>
            <Text color="white">{formatTokens(totalTokens)} tokens</Text>
          </>
        )}
        <Text color="gray"> │ </Text>
        <Text color={sessionCost > 0.01 ? 'yellow' : 'green'}>${sessionCost.toFixed(4)}</Text>
      </Text>
      <Text>
        <Text color="gray">{modelCount.local}L/{modelCount.cloud}C</Text>
        {sessionId && (
          <>
            <Text color="gray"> │ </Text>
            <Text color="gray">{sessionId.slice(0, 8)}</Text>
          </>
        )}
      </Text>
    </Box>
  );
}
