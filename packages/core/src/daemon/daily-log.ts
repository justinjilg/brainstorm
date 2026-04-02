/**
 * DailyLog — append-only daily log for daemon mode.
 *
 * Dual-write strategy:
 * 1. SQLite (daemon_daily_log) — queryable, survives crashes (WAL mode)
 * 2. Markdown files (~/.brainstorm/logs/YYYY/MM/YYYY-MM-DD.md) — human-readable, grep-friendly
 *
 * The markdown files are the "source of truth" for /dream consolidation,
 * while SQLite provides fast range queries for tick message summaries.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@brainst0rm/shared";
import type { DailyLogRepository, DailyLogEntry } from "@brainst0rm/db";

const log = createLogger("daily-log");

export interface DailyLogOptions {
  /** Base directory for daily log files. Defaults to ~/.brainstorm/logs */
  logDir?: string;
  /** SQLite repository for queryable persistence. */
  repo?: DailyLogRepository;
  /** Session ID for log attribution. */
  sessionId?: string;
}

export interface LogAppendOptions {
  tickNumber?: number;
  eventType?: string;
  cost?: number;
  modelId?: string;
}

export class DailyLog {
  private logDir: string;
  private repo?: DailyLogRepository;
  private sessionId?: string;

  constructor(options: DailyLogOptions = {}) {
    this.logDir = (options.logDir ?? "~/.brainstorm/logs").replace(
      "~",
      homedir(),
    );
    this.repo = options.repo;
    this.sessionId = options.sessionId;
  }

  /**
   * Append a log entry. Writes to both markdown file and SQLite.
   * Uses appendFileSync for crash safety — no data loss on kill -9.
   */
  append(content: string, opts: LogAppendOptions = {}): void {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toISOString().slice(11, 19); // HH:MM:SS
    const eventType = opts.eventType ?? "tick";

    // 1. Markdown file (append-only)
    const filePath = this.getFilePath(dateStr);
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });

    const tickPrefix =
      opts.tickNumber !== undefined ? ` [tick #${opts.tickNumber}]` : "";
    const costSuffix =
      opts.cost !== undefined ? ` ($${opts.cost.toFixed(4)})` : "";
    const line = `- **${timeStr}**${tickPrefix} [${eventType}]${costSuffix}: ${content}\n`;

    try {
      // Write header if file is new
      if (!existsSync(filePath)) {
        appendFileSync(filePath, `# Daemon Log — ${dateStr}\n\n`, "utf-8");
      }
      appendFileSync(filePath, line, "utf-8");
    } catch (err) {
      log.error({ err, filePath }, "Failed to append to daily log file");
    }

    // 2. SQLite (queryable)
    if (this.repo) {
      try {
        this.repo.append({
          sessionId: this.sessionId,
          logDate: dateStr,
          entryTime: Math.floor(now.getTime() / 1000),
          tickNumber: opts.tickNumber,
          eventType,
          content,
          cost: opts.cost ?? 0,
          modelId: opts.modelId,
        });
      } catch (err) {
        log.error({ err }, "Failed to append to daily log DB");
      }
    }
  }

  /** Read today's markdown log. */
  readToday(): string {
    const dateStr = new Date().toISOString().slice(0, 10);
    return this.readDate(dateStr);
  }

  /** Read a specific date's markdown log. */
  readDate(dateStr: string): string {
    const filePath = this.getFilePath(dateStr);
    if (!existsSync(filePath)) return "";
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  /** Read the last N days of logs (for /dream consolidation). */
  readRange(days: number): string {
    const parts: string[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const content = this.readDate(dateStr);
      if (content) parts.push(content);
    }
    return parts.join("\n---\n\n");
  }

  /** Get structured entries from SQLite for a date range. */
  readStructured(startDate: string, endDate: string): DailyLogEntry[] {
    if (!this.repo) return [];
    return this.repo.readRange(startDate, endDate);
  }

  /** Get recent entries from SQLite. */
  readRecent(limit = 50): DailyLogEntry[] {
    if (!this.repo) return [];
    return this.repo.readRecent(limit);
  }

  /** Get the markdown file path for a date. */
  private getFilePath(dateStr: string): string {
    const [year, month] = dateStr.split("-");
    return join(this.logDir, year, month, `${dateStr}.md`);
  }

  /** List all log dates that have files. */
  listDates(): string[] {
    const dates: string[] = [];
    if (!existsSync(this.logDir)) return dates;

    try {
      for (const year of readdirSync(this.logDir)) {
        const yearPath = join(this.logDir, year);
        if (!year.match(/^\d{4}$/)) continue;
        for (const month of readdirSync(yearPath)) {
          const monthPath = join(yearPath, month);
          if (!month.match(/^\d{2}$/)) continue;
          for (const file of readdirSync(monthPath)) {
            if (file.endsWith(".md") && file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) {
              dates.push(file.replace(".md", ""));
            }
          }
        }
      }
    } catch {
      // Directory structure may not exist yet
    }

    return dates.sort();
  }
}
