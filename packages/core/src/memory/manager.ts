import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "@brainst0rm/shared";
import type { BrainstormGateway } from "@brainst0rm/gateway";
import { initMemoryRepo, commitMemoryChange } from "./git.js";

const log = createLogger("memory");

export type MemoryTier = "system" | "archive";

export interface MemoryEntry {
  id: string;
  type: "user" | "project" | "feedback" | "reference";
  /** system = always in prompt. archive = index only, loaded on demand. */
  tier: MemoryTier;
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
/** Hard cap on total memory file size (excluding MEMORY.md index). */
const MAX_MEMORY_BYTES = 25 * 1024; // 25KB — matches Claude Code's cap

export class MemoryManager {
  private memoryDir: string;
  private systemDir: string;
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
    this.systemDir = join(this.memoryDir, "system");
    this.indexPath = join(this.memoryDir, "MEMORY.md");
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.systemDir, { recursive: true });
    initMemoryRepo(this.memoryDir);
    this.loadAll();
  }

  /** Save a memory entry. Creates or updates the file. */
  save(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "tier"> & {
      tier?: MemoryTier;
    },
  ): MemoryEntry {
    const id = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const now = Math.floor(Date.now() / 1000);
    const existing = this.entries.get(id);

    // Default tier: user/feedback → system (always in prompt), project/reference → archive
    const tier =
      entry.tier ??
      existing?.tier ??
      (entry.type === "user" || entry.type === "feedback"
        ? "system"
        : "archive");

    const memory: MemoryEntry = {
      id,
      ...entry,
      tier,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // If tier changed, remove from old location
    if (existing && existing.tier !== tier) {
      const oldDir =
        existing.tier === "system" ? this.systemDir : this.memoryDir;
      const oldPath = join(oldDir, `${id}.md`);
      try {
        unlinkSync(oldPath);
      } catch {
        /* may not exist */
      }
    }

    // Write memory file to the correct directory
    const targetDir = tier === "system" ? this.systemDir : this.memoryDir;
    const filePath = join(targetDir, `${id}.md`);
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
    this.enforceCapacity();
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

    // Git-track the change
    commitMemoryChange(
      this.memoryDir,
      `memory: ${existing ? "update" : "create"} ${memory.name}`,
    );

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
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);

    // Remove from correct directory based on tier
    const dir = entry.tier === "system" ? this.systemDir : this.memoryDir;
    const filePath = join(dir, `${id}.md`);
    try {
      unlinkSync(filePath);
    } catch (e) {
      log.warn({ err: e, filePath }, "Failed to delete memory file");
    }
    this.scheduleIndexUpdate();
    commitMemoryChange(this.memoryDir, `memory: delete ${entry.name}`);
    return true;
  }

  /**
   * Get context string for injection into system prompt.
   *
   * Progressive disclosure:
   * - system/ entries: full content always included
   * - archive entries: names + descriptions only (use memory search to load)
   */
  getContextString(): string {
    const parts: string[] = [];
    const systemEntries = this.list().filter((m) => m.tier === "system");
    const archiveEntries = this.list().filter((m) => m.tier === "archive");

    if (systemEntries.length > 0) {
      parts.push("### Active Memory (always loaded)\n");
      for (const m of systemEntries) {
        parts.push(`**${m.name}** (${m.type}): ${m.description}`);
        parts.push(m.content);
        parts.push("");
      }
    }

    if (archiveEntries.length > 0) {
      parts.push("### Archive (search to load)\n");
      for (const m of archiveEntries) {
        parts.push(`- **${m.name}** — ${m.description}`);
      }
      parts.push("");
    }

    return parts.join("\n").trim();
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
    // Load from both root (archive) and system/ directories
    this.loadFromDir(this.memoryDir, "archive");
    this.loadFromDir(this.systemDir, "system");
  }

  private loadFromDir(dir: string, tier: MemoryTier): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );

    for (const file of files) {
      const filePath = join(dir, file);
      // Skip directories (like system/)
      try {
        if (statSync(filePath).isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        const content = readFileSync(filePath, "utf-8");
        const stat = statSync(filePath);
        const entry = this.parseMemoryFile(file, content, stat.mtimeMs, tier);
        if (entry) {
          this.entries.set(entry.id, entry);
        } else {
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
    fileMtimeMs?: number,
    tier?: MemoryTier,
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

    // Use file modification time for LRU ordering instead of Date.now()
    const mtime = fileMtimeMs
      ? Math.floor(fileMtimeMs / 1000)
      : Math.floor(Date.now() / 1000);

    return {
      id,
      name,
      description,
      type,
      tier: tier ?? "archive",
      content: body,
      createdAt: mtime,
      updatedAt: mtime,
    };
  }

  /**
   * Enforce memory directory size cap via LRU eviction.
   * Evicts oldest entries (by updatedAt) until total size is under MAX_MEMORY_BYTES.
   * Entries with "[keep]" in their name are exempt from eviction.
   */
  private enforceCapacity(): void {
    const files = readdirSync(this.memoryDir).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );
    let totalBytes = 0;
    const fileSizes: Array<{
      id: string;
      file: string;
      bytes: number;
      updatedAt: number;
    }> = [];

    for (const file of files) {
      const filePath = join(this.memoryDir, file);
      try {
        const bytes = statSync(filePath).size;
        totalBytes += bytes;
        const id = file.replace(".md", "");
        const entry = this.entries.get(id);
        fileSizes.push({ id, file, bytes, updatedAt: entry?.updatedAt ?? 0 });
      } catch {
        /* file may have been deleted concurrently */
      }
    }

    if (totalBytes <= MAX_MEMORY_BYTES) return;

    // Sort by updatedAt ascending (oldest first) for LRU eviction
    // Entries with "[keep]" in name are pushed to the end (exempt)
    fileSizes.sort((a, b) => {
      const aKeep = this.entries.get(a.id)?.name.includes("[keep]") ? 1 : 0;
      const bKeep = this.entries.get(b.id)?.name.includes("[keep]") ? 1 : 0;
      if (aKeep !== bKeep) return aKeep - bKeep;
      return a.updatedAt - b.updatedAt;
    });

    let evicted = 0;
    for (const entry of fileSizes) {
      if (totalBytes <= MAX_MEMORY_BYTES) break;
      // Don't evict [keep] entries
      if (this.entries.get(entry.id)?.name.includes("[keep]")) continue;

      const filePath = join(this.memoryDir, entry.file);
      try {
        unlinkSync(filePath);
        this.entries.delete(entry.id);
        totalBytes -= entry.bytes;
        evicted++;
        log.info(
          { id: entry.id, bytes: entry.bytes },
          "Evicted memory entry (capacity exceeded)",
        );
      } catch (e) {
        log.warn({ err: e, id: entry.id }, "Failed to evict memory entry");
      }
    }

    if (evicted > 0) {
      log.info(
        { evicted, remainingBytes: totalBytes, cap: MAX_MEMORY_BYTES },
        "Memory capacity enforcement complete",
      );
    }
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

    const systemEntries = this.list().filter((m) => m.tier === "system");
    const archiveEntries = this.list().filter((m) => m.tier === "archive");

    const lines: string[] = [];
    if (systemEntries.length > 0) {
      lines.push("## System (always in prompt)\n");
      for (const m of systemEntries) {
        lines.push(`- [${m.name}](system/${m.id}.md) — ${m.description}`);
      }
      lines.push("");
    }
    if (archiveEntries.length > 0) {
      lines.push("## Archive (search to load)\n");
      for (const m of archiveEntries) {
        lines.push(`- [${m.name}](${m.id}.md) — ${m.description}`);
      }
    }

    writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
  }

  /** Promote an archive entry to system (always in prompt). */
  promote(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.tier === "system") return false;
    return !!this.save({ ...entry, tier: "system" });
  }

  /** Demote a system entry to archive (index only). */
  demote(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.tier === "archive") return false;
    return !!this.save({ ...entry, tier: "archive" });
  }

  /** List entries by tier. */
  listByTier(tier: MemoryTier): MemoryEntry[] {
    return this.list().filter((m) => m.tier === tier);
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
