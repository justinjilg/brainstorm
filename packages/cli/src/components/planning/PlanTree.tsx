/**
 * PlanTree — collapsible tree view for plan hierarchy.
 *
 * Shows: Phases → Sprints → Tasks with status icons,
 * progress counts, and keyboard navigation.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type {
  PlanFile,
  PlanPhase,
  PlanSprint,
  PlanTask,
  PlanNodeStatus,
} from "@brainst0rm/core";

function statusIcon(status: PlanNodeStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "failed":
      return "✗";
    case "blocked":
      return "▪";
    case "skipped":
      return "○";
    default:
      return "○";
  }
}

function statusColor(status: PlanNodeStatus): string {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "yellow";
    case "failed":
      return "red";
    case "blocked":
      return "gray";
    default:
      return "gray";
  }
}

interface TreeNode {
  id: string;
  label: string;
  status: PlanNodeStatus;
  depth: number;
  type: "phase" | "sprint" | "task";
  progress?: string;
  cost?: number;
  skill?: string;
  expandable: boolean;
}

function flattenPlan(plan: PlanFile, expanded: Set<string>): TreeNode[] {
  const nodes: TreeNode[] = [];

  for (const phase of plan.phases) {
    nodes.push({
      id: phase.id,
      label: phase.name,
      status: phase.status,
      depth: 0,
      type: "phase",
      progress: `${phase.completedCount}/${phase.taskCount}`,
      expandable: true,
    });

    if (!expanded.has(phase.id)) continue;

    for (const sprint of phase.sprints) {
      nodes.push({
        id: sprint.id,
        label: sprint.name,
        status: sprint.status,
        depth: 1,
        type: "sprint",
        expandable: true,
      });

      if (!expanded.has(sprint.id)) continue;

      for (const task of sprint.tasks) {
        nodes.push({
          id: task.id,
          label: task.description,
          status: task.status,
          depth: 2,
          type: "task",
          cost: task.cost,
          skill: task.assignedSkill,
          expandable: false,
        });
      }
    }
  }

  return nodes;
}

interface PlanTreeProps {
  plan: PlanFile;
  selectedId: string | null;
  onSelect: (id: string, type: "phase" | "sprint" | "task") => void;
  maxHeight?: number;
  isActive?: boolean;
}

export function PlanTree({
  plan,
  selectedId,
  onSelect,
  maxHeight = 20,
  isActive = true,
}: PlanTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Auto-expand phases that are in progress
    const initial = new Set<string>();
    for (const phase of plan.phases) {
      if (phase.status === "in_progress" || phase.status === "pending") {
        initial.add(phase.id);
        for (const sprint of phase.sprints) {
          if (sprint.status === "in_progress" || sprint.status === "pending") {
            initial.add(sprint.id);
          }
        }
      }
    }
    return initial;
  });
  const [cursor, setCursor] = useState(0);

  const nodes = flattenPlan(plan, expanded);

  useInput((input, key) => {
    if (!isActive) return;

    if (key.downArrow || input === "j") {
      setCursor((prev) => Math.min(prev + 1, nodes.length - 1));
    }
    if (key.upArrow || input === "k") {
      setCursor((prev) => Math.max(prev - 1, 0));
    }
    if (key.return) {
      const node = nodes[cursor];
      if (!node) return;

      if (node.expandable) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
      }
      onSelect(node.id, node.type);
    }
  });

  // Keep cursor in bounds
  const safeCursor = Math.min(cursor, nodes.length - 1);
  const selectedNode = nodes[safeCursor];

  // Notify parent of selection change (must be in useEffect, not during render)
  useEffect(() => {
    if (selectedNode && selectedNode.id !== selectedId) {
      onSelect(selectedNode.id, selectedNode.type);
    }
  }, [selectedNode?.id]);

  // Scroll window
  const scrollOffset = Math.max(0, safeCursor - maxHeight + 3);
  const visibleNodes = nodes.slice(scrollOffset, scrollOffset + maxHeight);

  return (
    <Box flexDirection="column">
      {/* Plan header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {plan.name}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="gray">
          {plan.completedTasks}/{plan.totalTasks} tasks
        </Text>
      </Box>

      {/* Tree nodes */}
      {visibleNodes.map((node, i) => {
        const actualIdx = scrollOffset + i;
        const isCursor = actualIdx === safeCursor;
        const indent = "  ".repeat(node.depth);
        const expandIcon = node.expandable
          ? expanded.has(node.id)
            ? "▼ "
            : "▶ "
          : "  ";

        return (
          <Box key={node.id}>
            <Text color={isCursor ? "cyan" : undefined}>
              {isCursor ? "→ " : "  "}
            </Text>
            <Text dimColor={!isCursor}>{indent}</Text>
            <Text color={statusColor(node.status)}>
              {statusIcon(node.status)}{" "}
            </Text>
            <Text dimColor={!isCursor}>{expandIcon}</Text>
            <Text
              color={isCursor ? "white" : "gray"}
              bold={isCursor}
              wrap="truncate"
            >
              {node.label.slice(0, 35)}
            </Text>
            {node.progress && (
              <Text color="gray" dimColor>
                {" "}
                {node.progress}
              </Text>
            )}
            {node.skill && (
              <Text color="cyan" dimColor>
                {" "}
                [{node.skill}]
              </Text>
            )}
            {node.cost !== undefined && node.cost > 0 && (
              <Text color="gray" dimColor>
                {" "}
                ${node.cost.toFixed(2)}
              </Text>
            )}
          </Box>
        );
      })}

      {scrollOffset > 0 && (
        <Text color="gray" dimColor>
          {" "}
          ↑ {scrollOffset} more
        </Text>
      )}
      {scrollOffset + maxHeight < nodes.length && (
        <Text color="gray" dimColor>
          {" "}
          ↓ {nodes.length - scrollOffset - maxHeight} more
        </Text>
      )}
    </Box>
  );
}
