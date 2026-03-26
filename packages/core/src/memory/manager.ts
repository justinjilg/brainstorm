import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "@brainstorm/shared";
import type { BrainstormGateway } from "@brainstorm/gateway";

const log = createLogger("memory");

export interface MemoryEntry {
  id: string;
  type: "user" | "project" | "feedback" | "reference";
  name: string;
  description: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * MemoryManager — persistent memory across sessions.
 *
 * Storage: ~/.brainstorm/projects/<project-hash>/memory/
 * Index: MEMORY.md (first 200 lines loaded at session start)
 *
 * Gateway push: When a BrainstormGateway client is provided, saved entries
 * are pushed fire-and-forget to the cloud RMM. Local is source of truth.
 */
const INDEX_DEBOUNCE_MS = 2000;

export class MemoryManager {
  private memoryDir: string;
  private indexPath: string;
  private entries: Map<string, MemoryEntry> = new Map();
  private indexDirty = false;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private gateway: BrainstormGateway | null;

  constructor(projectPath: string, gateway?: BrainstormGateway | null) {
    this.gateway = gateway ?? null;
    const projectHash = createHash("sha256")
      .update(projectPath)
      .digest("hex")
      .slice(0, 16);
    this.memoryDir = join(
      homedir(),
      ".brainstorm",
      "projects",
      projectHash,
      "memory",
    );
    this.indexPath = join(this.memoryDir, "MEMORY.md");
    mkdirSync(this.memoryDir, { recursive: true });
    this.loadAll();
  }

  /** Save a memory entry. Creates or updates the file. */
  save(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">,
  ): MemoryEntry {
    const id = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const now = Math.floor(Date.now() / 1000);
    const existing = this.entries.get(id);

    const memory: MemoryEntry = {
      id,
      ...entry,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Write memory file
    const filePath = join(this.memoryDir, `${id}.md`);
    const fileContent = [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      "---",
      "",
      memory.content,
    ].join("\n");
    writeFileSync(filePath, fileContent, "utf-8");

    this.entries.set(id, memory);
    this.scheduleIndexUpdate();

    // Fire-and-forget push to gateway
    if (this.gateway) {
      this.gateway
        .storeMemory(memory.type, `[${memory.name}] ${memory.content}`)
        .catch((e) => {
          log.warn(
            { err: e, memoryId: id },
            "Failed to push memory to gateway",
          );
        });
    }

    return memory;
  }

  /** Get a memory entry by ID. */
  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  /** List all memory entries. */
  list(): MemoryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Delete a memory entry. */
  delete(id: string): boolean {
    if (!this.entries.has(id)) return false;
    this.entries.delete(id);
    const filePath = join(this.memoryDir, `${id}.md`);
    try {
      unlinkSync(filePath);
    } catch (e) {
      log.warn({ err: e, filePath }, "Failed to delete memory file");
    }
    this.scheduleIndexUpdate();
    return true;
  }

  /** Get context string for injection into system prompt (first 200 lines of index). */
  getContextString(): string {
    if (!existsSync(this.indexPath)) return "";
    const content = readFileSync(this.indexPath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(0, 200).join("\n");
  }

  /** Get the memory directory path (for subagent access). */
  getMemoryDir(): string {
    return this.memoryDir;
  }

  /** Get raw file contents for all memory files (for dream consolidation). */
  getRawFiles(): Array<{ filename: string; content: string }> {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        filename: f,
        content: readFileSync(join(this.memoryDir, f), "utf-8"),
      }));
  }

  /** Search memories by TF-IDF relevance, with keyword fallback. */
  search(query: string): MemoryEntry[] {
    const entries = this.list();
    if (entries.length === 0) return [];

    const lower = query.toLowerCase();
    const queryTerms = lower
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);

    if (queryTerms.length === 0) return [];

    // Score each entry by term frequency overlap
    const scored = entries.map((m) => {
      const text = `${m.name} ${m.description} ${m.content}`.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (text.includes(term)) {
          // Count occurrences for TF-like scoring
          const count = text.split(term).length - 1;
          score += Math.log(1 + count);
        }
      }
      // Boost exact phrase matches
      if (text.includes(lower)) score += 2;
      return { entry: m, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry);
  }

  private loadAll(): void {
    if (!existsSync(this.memoryDir)) return;
    const files = readdirSync(this.memoryDir).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );

    for (const file of files) {
      const filePath = join(this.memoryDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const entry = this.parseMemoryFile(file, content);
        if (entry) {
          this.entries.set(entry.id, entry);
        } else {
          // File exists but couldn't parse — backup and warn
          this.backupCorruptFile(filePath, file);
        }
      } catch (e) {
        log.warn({ err: e, file }, "Failed to read memory file");
        this.backupCorruptFile(filePath, file);
      }
    }
  }

  private parseMemoryFile(
    filename: string,
    content: string,
  ): MemoryEntry | null {
    const id = filename.replace(".md", "");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const body = fmMatch[2].trim();

    const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() ?? id;
    const description = fm.match(/description:\s*(.+)/)?.[1]?.trim() ?? "";
    const type = (fm.match(/type:\s*(.+)/)?.[1]?.trim() ??
      "project") as MemoryEntry["type"];

    return {
      id,
      name,
      description,
      type,
      content: body,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }

  /** Schedule a debounced index rebuild. */
  private scheduleIndexUpdate(): void {
    this.indexDirty = true;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.flushIndex();
    }, INDEX_DEBOUNCE_MS);
  }

  /** Immediately write the index file if dirty. */
  flushIndex(): void {
    if (!this.indexDirty) return;
    this.indexDirty = false;
    const lines = this.list().map(
      (m) => `- [${m.name}](${m.id}.md) — ${m.description}`,
    );
    writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
  }

  private updateIndex(): void {
    const lines = this.list().map(
      (m) => `- [${m.name}](${m.id}.md) — ${m.description}`,
    );
    writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
  }

  /** Backup a corrupt memory file instead of deleting it. */
  private backupCorruptFile(filePath: string, filename: string): void {
    try {
      const backupPath = `${filePath}.corrupt`;
      renameSync(filePath, backupPath);
      log.warn(
        { file: filename, backup: backupPath },
        "Corrupt memory file backed up",
      );
    } catch (e) {
      log.warn({ err: e, file: filename }, "Failed to backup corrupt file");
    }
  }
}
