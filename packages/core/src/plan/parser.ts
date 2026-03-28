/**
 * Plan file parser — reads .plan.md files into PlanFile tree structure.
 *
 * Format:
 * - YAML frontmatter: plan metadata (name, status, dates)
 * - ## headings: Phases
 * - ### headings: Sprints
 * - - [x] / - [ ]: Tasks (with optional {key:value} metadata)
 *
 * Also supports write-back: toggles [x] checkboxes and appends cost metadata.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type {
  PlanFile,
  PlanPhase,
  PlanSprint,
  PlanTask,
  PlanNodeStatus,
} from "./types.js";

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a .plan.md file into a PlanFile tree.
 */
export function parsePlanFile(filePath: string): PlanFile {
  const content = readFileSync(filePath, "utf-8");
  return parsePlanContent(content, filePath);
}

/**
 * Parse plan content string (for testing without filesystem).
 */
export function parsePlanContent(content: string, filePath = ""): PlanFile {
  const lines = content.split("\n");
  let cursor = 0;

  // Parse YAML frontmatter
  let name = basename(filePath, ".plan.md") || "Untitled Plan";
  let status: PlanNodeStatus = "pending";
  let createdDate: string | undefined;
  let targetDate: string | undefined;

  if (lines[0]?.trim() === "---") {
    cursor = 1;
    while (cursor < lines.length && lines[cursor].trim() !== "---") {
      const line = lines[cursor].trim();
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        const cleanValue = value.replace(/^["']|["']$/g, "");
        switch (key) {
          case "name":
            name = cleanValue;
            break;
          case "plan":
            // plan ID, used for file stem
            break;
          case "status":
            status = cleanValue as PlanNodeStatus;
            break;
          case "created":
            createdDate = cleanValue;
            break;
          case "target":
            targetDate = cleanValue;
            break;
        }
      }
      cursor++;
    }
    cursor++; // skip closing ---
  }

  // Parse body: phases, sprints, tasks
  const phases: PlanPhase[] = [];
  let currentPhase: PlanPhase | null = null;
  let currentSprint: PlanSprint | null = null;
  let phaseIdx = 0;
  let sprintIdx = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    const lineNumber = cursor + 1; // 1-indexed

    // Phase: ## heading
    const phaseMatch = line.match(/^##\s+(.+)/);
    if (phaseMatch && !line.startsWith("###")) {
      if (currentPhase) {
        if (currentSprint) {
          currentPhase.sprints.push(currentSprint);
          currentSprint = null;
        }
        rollUpPhase(currentPhase);
        phases.push(currentPhase);
      }
      phaseIdx++;
      sprintIdx = 0;

      const phaseName = phaseMatch[1].trim();
      currentPhase = {
        id: `phase-${phaseIdx}`,
        name: phaseName,
        status: "pending",
        sprints: [],
        taskCount: 0,
        completedCount: 0,
      };

      // Check for status line after heading
      if (
        cursor + 1 < lines.length &&
        lines[cursor + 1].match(/^status:\s*(\w+)/)
      ) {
        const statusMatch = lines[cursor + 1].match(/^status:\s*(\w+)/);
        if (statusMatch) {
          currentPhase.status = statusMatch[1] as PlanNodeStatus;
        }
        cursor++;
      }

      // Check for start date
      if (
        cursor + 1 < lines.length &&
        lines[cursor + 1].match(/^start:\s*(.+)/)
      ) {
        const startMatch = lines[cursor + 1].match(/^start:\s*(.+)/);
        if (startMatch) {
          currentPhase.startDate = startMatch[1].trim();
        }
        cursor++;
      }

      cursor++;
      continue;
    }

    // Sprint: ### heading
    const sprintMatch = line.match(/^###\s+(.+)/);
    if (sprintMatch) {
      if (currentSprint && currentPhase) {
        currentPhase.sprints.push(currentSprint);
      }
      sprintIdx++;
      currentSprint = {
        id: `phase-${phaseIdx}-sprint-${sprintIdx}`,
        name: sprintMatch[1].trim(),
        status: "pending",
        tasks: [],
      };
      cursor++;
      continue;
    }

    // Task: - [x] or - [ ]
    const taskMatch = line.match(/^-\s+\[([ xX])\]\s+(.+)/);
    if (taskMatch) {
      const isCompleted = taskMatch[1].toLowerCase() === "x";
      const rawDescription = taskMatch[2];

      // Parse inline metadata: {key:value key2:value2}
      const metadata: Record<string, string> = {};
      const metaMatch = rawDescription.match(/\{([^}]+)\}/);
      if (metaMatch) {
        for (const pair of metaMatch[1].split(/\s+/)) {
          const [k, v] = pair.split(":");
          if (k && v) metadata[k] = v;
        }
      }

      const description = rawDescription.replace(/\s*\{[^}]+\}/, "").trim();
      const taskId = description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 50);

      const task: PlanTask = {
        id: taskId,
        description,
        status: isCompleted ? "completed" : "pending",
        assignedSkill: metadata.skill,
        cost: metadata.cost
          ? parseFloat(metadata.cost.replace("$", ""))
          : undefined,
        modelUsed: metadata.model,
        readonly: metadata.readonly === "true",
        metadata,
        lineNumber,
      };

      // Add to current sprint or create default sprint
      if (!currentSprint && currentPhase) {
        currentSprint = {
          id: `phase-${phaseIdx}-sprint-1`,
          name: "Tasks",
          status: "pending",
          tasks: [],
        };
      }
      if (currentSprint) {
        currentSprint.tasks.push(task);
      }

      cursor++;
      continue;
    }

    cursor++;
  }

  // Flush remaining phase/sprint
  if (currentSprint && currentPhase) {
    currentPhase.sprints.push(currentSprint);
  }
  if (currentPhase) {
    rollUpPhase(currentPhase);
    phases.push(currentPhase);
  }

  // Calculate totals
  let totalTasks = 0;
  let completedTasks = 0;
  for (const phase of phases) {
    totalTasks += phase.taskCount;
    completedTasks += phase.completedCount;
  }

  // Derive overall status
  if (completedTasks === totalTasks && totalTasks > 0) status = "completed";
  else if (completedTasks > 0) status = "in_progress";

  return {
    id: basename(filePath, ".plan.md"),
    filePath,
    name,
    status,
    createdDate,
    targetDate,
    phases,
    totalTasks,
    completedTasks,
  };
}

function rollUpPhase(phase: PlanPhase): void {
  phase.taskCount = 0;
  phase.completedCount = 0;

  for (const sprint of phase.sprints) {
    phase.taskCount += sprint.tasks.length;
    const completed = sprint.tasks.filter(
      (t) => t.status === "completed",
    ).length;
    phase.completedCount += completed;

    // Sprint status rollup
    if (completed === sprint.tasks.length && sprint.tasks.length > 0) {
      sprint.status = "completed";
    } else if (
      completed > 0 ||
      sprint.tasks.some((t) => t.status === "in_progress")
    ) {
      sprint.status = "in_progress";
    }
  }

  // Phase status rollup (if not explicitly set)
  if (phase.status === "pending") {
    if (phase.completedCount === phase.taskCount && phase.taskCount > 0) {
      phase.status = "completed";
    } else if (phase.completedCount > 0) {
      phase.status = "in_progress";
    }
  }
}

// ── Write-Back ──────────────────────────────────────────────────────

/**
 * Update a task's checkbox and metadata in the plan file.
 * Toggles `- [ ]` to `- [x]` and appends `{cost:$X.XX model:name}`.
 */
export function updateTaskInFile(
  filePath: string,
  task: PlanTask,
  updates: {
    completed?: boolean;
    cost?: number;
    model?: string;
    skill?: string;
  },
): void {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const lineIdx = task.lineNumber - 1; // 0-indexed

  if (lineIdx < 0 || lineIdx >= lines.length) return;

  let line = lines[lineIdx];

  // Toggle checkbox
  if (updates.completed !== undefined) {
    if (updates.completed) {
      line = line.replace(/\[\s\]/, "[x]");
    } else {
      line = line.replace(/\[[xX]\]/, "[ ]");
    }
  }

  // Build metadata string
  const meta: string[] = [];
  if (updates.skill) meta.push(`skill:${updates.skill}`);
  if (updates.model) meta.push(`model:${updates.model}`);
  if (updates.cost !== undefined) meta.push(`cost:$${updates.cost.toFixed(2)}`);

  if (meta.length > 0) {
    // Replace existing metadata or append
    if (line.match(/\{[^}]+\}/)) {
      line = line.replace(/\{[^}]+\}/, `{${meta.join(" ")}}`);
    } else {
      line = `${line} {${meta.join(" ")}}`;
    }
  }

  lines[lineIdx] = line;
  writeFileSync(filePath, lines.join("\n"), "utf-8");
}
