import React from 'react';
import { Box, Text } from 'ink';
import type { AgentTask } from '@brainstorm/shared';

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending: { icon: '○', color: 'gray' },
  in_progress: { icon: '◉', color: 'yellow' },
  completed: { icon: '●', color: 'green' },
  failed: { icon: '✗', color: 'red' },
};

interface TaskListProps {
  tasks: AgentTask[];
}

export function TaskList({ tasks }: TaskListProps) {
  // Only show tasks that aren't all completed (hide when done)
  const hasActive = tasks.some((t) => t.status !== 'completed' && t.status !== 'failed');
  if (!hasActive && tasks.length > 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Text color="gray" dimColor>  tasks</Text>
      {tasks.map((task) => {
        const { icon, color } = STATUS_ICONS[task.status] ?? STATUS_ICONS.pending;
        return (
          <Box key={task.id}>
            <Text color={color}>{`  ${icon} `}</Text>
            <Text color={task.status === 'completed' ? 'gray' : undefined} dimColor={task.status === 'completed'}>
              {task.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
