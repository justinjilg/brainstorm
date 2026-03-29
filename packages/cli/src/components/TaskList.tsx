import React from "react";
import { Box, Text } from "ink";
import type { AgentTask } from "@brainst0rm/shared";

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending: { icon: "○", color: "gray" },
  in_progress: { icon: "◉", color: "yellow" },
  completed: { icon: "●", color: "green" },
  failed: { icon: "✗", color: "red" },
};

interface TaskListProps {
  tasks: AgentTask[];
}

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) return null;

  const completed = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length;
  const allDone = completed + failed === total;

  // Hide when all tasks are done (after a brief display)
  if (allDone && completed === total) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Text color="gray" dimColor>
        {"  "}tasks ({completed}/{total} complete
        {failed > 0 ? `, ${failed} failed` : ""})
      </Text>
      {tasks.map((task) => {
        const { icon, color } =
          STATUS_ICONS[task.status] ?? STATUS_ICONS.pending;
        const isDone = task.status === "completed";
        return (
          <Box key={task.id}>
            <Text color={color}>{`  ${icon} `}</Text>
            <Text color={isDone ? "gray" : undefined} dimColor={isDone}>
              {task.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
