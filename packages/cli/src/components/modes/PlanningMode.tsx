/**
 * PlanningMode — Mode 5: Real-time plan execution visualization.
 *
 * Left panel: collapsible tree of phases/sprints/tasks
 * Right panel: detail for selected node
 * Bottom: activity bar with active task + skill usage
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { PlanTree } from "../planning/PlanTree.js";
import type { PlanFile, PlanPhase, PlanTask } from "@brainstorm/core";
import { parsePlanContent } from "@brainstorm/core";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface PlanningModeProps {
  projectPath?: string;
}

function loadPlans(projectPath: string): PlanFile[] {
  const plans: PlanFile[] = [];
  const planDirs = [
    join(projectPath, ".claude", "plans"),
    join(projectPath, ".brainstorm", "plans"),
  ];

  for (const dir of planDirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".plan.md")) continue;
      try {
        const filePath = join(dir, file);
        const content = readFileSync(filePath, "utf-8");
        plans.push(parsePlanContent(content, filePath));
      } catch {
        // Skip unparseable files
      }
    }
  }

  return plans;
}

export function PlanningMode({ projectPath }: PlanningModeProps) {
  const [plans, setPlans] = useState<PlanFile[]>([]);
  const [activePlanIdx, setActivePlanIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<
    "phase" | "sprint" | "task" | null
  >(null);

  useEffect(() => {
    const cwd = projectPath || process.cwd();
    setPlans(loadPlans(cwd));
  }, [projectPath]);

  useInput((input, key) => {
    // Switch between plans with [ and ]
    if (input === "[" && plans.length > 1) {
      setActivePlanIdx((prev) => Math.max(0, prev - 1));
    }
    if (input === "]" && plans.length > 1) {
      setActivePlanIdx((prev) => Math.min(plans.length - 1, prev + 1));
    }
  });

  if (plans.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">
          Planning
        </Text>
        <Box marginTop={1}>
          <Text color="gray">
            No .plan.md files found. Create one at .claude/plans/my-plan.plan.md
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Format: YAML frontmatter + ## Phases + ### Sprints + - [x] Tasks
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Execute: storm plan execute {"<path>"} [--dry-run] [--auto]
          </Text>
        </Box>
      </Box>
    );
  }

  const activePlan = plans[activePlanIdx];

  // Find selected node details
  let selectedPhase: PlanPhase | null = null;
  let selectedTask: PlanTask | null = null;

  if (selectedId && activePlan) {
    for (const phase of activePlan.phases) {
      if (phase.id === selectedId) {
        selectedPhase = phase;
        break;
      }
      for (const sprint of phase.sprints) {
        if (sprint.id === selectedId) {
          selectedPhase = phase;
          break;
        }
        for (const task of sprint.tasks) {
          if (task.id === selectedId) {
            selectedTask = task;
            selectedPhase = phase;
            break;
          }
        }
      }
    }
  }

  const progress =
    activePlan.totalTasks > 0
      ? Math.round((activePlan.completedTasks / activePlan.totalTasks) * 100)
      : 0;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      {/* Plan selector (if multiple) */}
      {plans.length > 1 && (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>
            [ ] switch plan:{" "}
          </Text>
          {plans.map((p, i) => (
            <Box key={p.id} marginRight={1}>
              <Text
                color={i === activePlanIdx ? "cyan" : "gray"}
                bold={i === activePlanIdx}
              >
                {p.name.slice(0, 20)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Progress bar */}
      <Box marginBottom={1}>
        <Text color="gray">Progress: </Text>
        <Text
          color={progress >= 100 ? "green" : progress > 0 ? "yellow" : "gray"}
        >
          {"█".repeat(Math.round(progress / 5))}
          {"░".repeat(20 - Math.round(progress / 5))}
        </Text>
        <Text color="gray"> {progress}% </Text>
        <Text color="gray" dimColor>
          ({activePlan.completedTasks}/{activePlan.totalTasks})
        </Text>
      </Box>

      {/* Main content: tree + detail */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left: Tree */}
        <Box width="45%" flexDirection="column">
          <PlanTree
            plan={activePlan}
            selectedId={selectedId}
            onSelect={(id, type) => {
              setSelectedId(id);
              setSelectedType(type);
            }}
          />
        </Box>

        {/* Separator */}
        <Box width={1} marginX={1}>
          <Text color="gray" dimColor>
            │
          </Text>
        </Box>

        {/* Right: Detail */}
        <Box width="50%" flexDirection="column">
          {selectedPhase && selectedType === "phase" && (
            <PhaseDetail phase={selectedPhase} />
          )}
          {selectedTask && selectedType === "task" && (
            <TaskDetail task={selectedTask} />
          )}
          {!selectedId && (
            <Box>
              <Text color="gray">Select a node to see details</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function PhaseDetail({ phase }: { phase: PlanPhase }) {
  return (
    <Box flexDirection="column">
      <Text bold color="white">
        {phase.name}
      </Text>
      <Text color="gray" dimColor>
        {phase.completedCount}/{phase.taskCount} tasks
      </Text>
      <Box marginTop={1} flexDirection="column">
        {phase.sprints.map((sprint) => (
          <Box key={sprint.id} flexDirection="column" marginBottom={1}>
            <Text color="gray">{sprint.name}</Text>
            {sprint.tasks.map((task) => {
              const icon =
                task.status === "completed"
                  ? "✓"
                  : task.status === "in_progress"
                    ? "◐"
                    : "○";
              const color =
                task.status === "completed"
                  ? "green"
                  : task.status === "in_progress"
                    ? "yellow"
                    : "gray";
              return (
                <Box key={task.id} paddingLeft={2}>
                  <Text color={color}>{icon} </Text>
                  <Text color="gray" wrap="truncate">
                    {task.description.slice(0, 45)}
                  </Text>
                  {task.cost !== undefined && task.cost > 0 && (
                    <Text color="gray" dimColor>
                      {" "}
                      ${task.cost.toFixed(2)}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function TaskDetail({ task }: { task: PlanTask }) {
  return (
    <Box flexDirection="column">
      <Text bold color="white">
        {task.description}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          Status:{" "}
          <Text color={task.status === "completed" ? "green" : "yellow"}>
            {task.status}
          </Text>
        </Text>
        {task.assignedSkill && (
          <Text color="gray">
            Skill: <Text color="cyan">{task.assignedSkill}</Text>
          </Text>
        )}
        {task.modelUsed && (
          <Text color="gray">
            Model: <Text color="green">{task.modelUsed}</Text>
          </Text>
        )}
        {task.cost !== undefined && task.cost > 0 && (
          <Text color="gray">
            Cost: <Text color="yellow">${task.cost.toFixed(4)}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
