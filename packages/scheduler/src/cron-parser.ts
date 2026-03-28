/**
 * Cron expression parsing and next-run computation.
 *
 * Wraps the `cron-parser` npm package (v5) with a simpler API.
 */

import { CronExpressionParser } from "cron-parser";

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateCron(expression: string): string | null {
  try {
    CronExpressionParser.parse(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid cron expression";
  }
}

/**
 * Compute the next run time for a cron expression.
 * Returns a Unix timestamp (seconds), or null if the expression is invalid.
 */
export function getNextRunTime(
  expression: string,
  afterTimestamp?: number,
): number | null {
  try {
    const options = afterTimestamp
      ? { currentDate: new Date(afterTimestamp * 1000) }
      : undefined;
    const interval = CronExpressionParser.parse(expression, options);
    const next = interval.next();
    return Math.floor(next.getTime() / 1000);
  } catch {
    return null;
  }
}

/**
 * Check if a task is due to run now (or was due in the past but hasn't run yet).
 */
export function isDue(
  cronExpression: string,
  lastRunTimestamp: number | null,
): boolean {
  if (!cronExpression) return false;

  const now = Math.floor(Date.now() / 1000);
  const afterTime = lastRunTimestamp ?? now - 86400;

  const nextRun = getNextRunTime(cronExpression, afterTime);
  if (!nextRun) return false;

  return nextRun <= now;
}

/**
 * Format a cron expression as a human-readable description.
 */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;

  const [min, hour, dom, mon, dow] = parts;

  if (
    min === "0" &&
    hour !== "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Daily at ${hour}:00`;
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    const days: Record<string, string> = {
      "0": "Sun",
      "1": "Mon",
      "2": "Tue",
      "3": "Wed",
      "4": "Thu",
      "5": "Fri",
      "6": "Sat",
      "7": "Sun",
    };
    return `${days[dow] ?? dow} at ${hour}:${min.padStart(2, "0")}`;
  }
  if (expression === "*/5 * * * *") return "Every 5 minutes";
  if (expression === "*/15 * * * *") return "Every 15 minutes";
  if (expression === "*/30 * * * *") return "Every 30 minutes";
  if (expression === "0 * * * *") return "Every hour";

  return expression;
}
