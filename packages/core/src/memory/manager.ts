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

export type MemoryTier = "system" | "archive" | "quarantine";

export type MemorySource =
  | "user_input"
  | "web_fetch"
  | "agent_extraction"
  | "dream_consolidation"
  | "import"
  | "local_file"
  | "unknown";

/** Default trust scores by source. Higher = more trusted. */
const DEFAULT_TRUST: Record<MemorySource, number> = {
  user_input: 1.0,
  local_file: 0.6,
  agent_extraction: 0.5,
  dream_consolidation: 0.7,
  web_fetch: 0.2,
  import: 0.3,
  unknown: 0.4,
};

/** Threshold below which entries are quarantined instead of stored normally. */
const QUARANTINE_THRESHOLD = 0.4;

export interface MemoryEntry {
  id: string;
  type: "user" | "project" | "feedback" | "reference";
  /** system = always in prompt. archive = index only. quarantine = untrusted, not injected. */
  tier: MemoryTier;
  name: string;
  description: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Where this entry originated. */
  source: MemorySource;
  /** URL if sourced from web. */
  sourceUrl?: string;
  /** Trust score 0.0-1.0. Derived from source, can be overridden. */
  trustScore: number;
  /** SHA256 of content for tamper detection. */
  contentHash: string;
  /** Who created this entry (user, agent model ID, dream, import). */
  author?: string;
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
  private quarantineDir: string;
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
    this.quarantineDir = join(this.memoryDir, "quarantine");
    this.indexPath = join(this.memoryDir, "MEMORY.md");
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.systemDir, { recursive: true });
    mkdirSync(this.quarantineDir, { recursive: true });
    initMemoryRepo(this.memoryDir);
    this.loadAll();
  }

  /** Save a memory entry. Creates or updates the file. */
  save(
    entry: Omit<
      MemoryEntry,
      "id" | "createdAt" | "updatedAt" | "tier" | "trustScore" | "contentHash"
    > & {
      tier?: MemoryTier;
      trustScore?: number;
    },
  ): MemoryEntry {
    const id = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const now = Math.floor(Date.now() / 1000);
    const existing = this.entries.get(id);

    // Resolve trust score from explicit value, existing entry, or source default
    const source = entry.source ?? "unknown";
    const trustScore =
      entry.trustScore ?? existing?.trustScore ?? DEFAULT_TRUST[source];
    const contentHash = createHash("sha256")
      .update(entry.content)
      .digest("hex")
      .slice(0, 16);

    // Quarantine low-trust entries — never auto-promote to system tier
    let tier: MemoryTier;
    if (trustScore < QUARANTINE_THRESHOLD && !entry.tier) {
      tier = "quarantine";
      log.info({ id, source, trustScore }, "Low-trust entry quarantined");
    } else if (
      entry.tier === "system" &&
      source === "web_fetch" &&
      trustScore < 0.7
    ) {
      // Block web-sourced entries from system tier unless high trust
      tier = "archive";
      log.warn(
        { id, source, trustScore },
        "Web-sourced entry blocked from system tier — demoted to archive",
      );
    } else {
      tier =
        entry.tier ??
        existing?.tier ??
        (entry.type === "user" || entry.type === "feedback"
          ? "system"
          : "archive");
    }

    const memory: MemoryEntry = {
      id,
      ...entry,
      source,
      tier,
      trustScore,
      contentHash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // If tier changed, remove from old location
    if (existing && existing.tier !== tier) {
      const oldDir =
        existing.tier === "system"
          ? this.systemDir
          : existing.tier === "quarantine"
            ? this.quarantineDir
            : this.memoryDir;
      const oldPath = join(oldDir, `${id}.md`);
      try {
        unlinkSync(oldPath);
      } catch {
        /* may not exist */
      }
    }

    // Write memory file to the correct directory
    const targetDir =
      tier === "system"
        ? this.systemDir
        : tier === "quarantine"
          ? this.quarantineDir
          : this.memoryDir;
    const filePath = join(targetDir, `${id}.md`);
    const fmLines = [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `source: ${memory.source}`,
      `trustScore: ${memory.trustScore}`,
      `contentHash: ${memory.contentHash}`,
    ];
    if (memory.sourceUrl) fmLines.push(`sourceUrl: ${memory.sourceUrl}`);
    if (memory.author) fmLines.push(`author: ${memory.author}`);
    fmLines.push("---", "", memory.content);
    writeFileSync(filePath, fmLines.join("\n"), "utf-8");

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
    const dir =
      entry.tier === "system"
        ? this.systemDir
        : entry.tier === "quarantine"
          ? this.quarantineDir
          : this.memoryDir;
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
    const quarantinedEntries = this.list().filter(
      (m) => m.tier === "quarantine",
    );

    if (systemEntries.length > 0) {
      parts.push("### Active Memory (always loaded)\n");
      for (const m of systemEntries) {
        const trustTag =
          m.source !== "user_input"
            ? ` [source: ${m.source}, trust: ${m.trustScore.toFixed(1)}]`
            : "";
        parts.push(`**${m.name}** (${m.type})${trustTag}: ${m.description}`);
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

    // Quarantined entries are NOT injected as content — only listed as warnings
    if (quarantinedEntries.length > 0) {
      parts.push(
        `### Quarantined (${quarantinedEntries.length} entries — untrusted, not loaded)\n`,
      );
      for (const m of quarantinedEntries) {
        parts.push(
          `- **${m.name}** [${m.source}, trust: ${m.trustScore.toFixed(1)}] — ${m.description}`,
        );
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
    // Load from root (archive), system/, and quarantine/ directories
    this.loadFromDir(this.memoryDir, "archive");
    this.loadFromDir(this.systemDir, "system");
    this.loadFromDir(this.quarantineDir, "quarantine");
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

    // Provenance fields (backwards-compatible: defaults for legacy entries)
    const source = (fm.match(/source:\s*(.+)/)?.[1]?.trim() ??
      "unknown") as MemorySource;
    const trustScore =
      parseFloat(fm.match(/trustScore:\s*(.+)/)?.[1]?.trim() ?? "") ||
      DEFAULT_TRUST[source];
    const storedHash = fm.match(/contentHash:\s*(.+)/)?.[1]?.trim();
    const sourceUrl = fm.match(/sourceUrl:\s*(.+)/)?.[1]?.trim();
    const author = fm.match(/author:\s*(.+)/)?.[1]?.trim();

    // Integrity check: verify content hash if stored
    const computedHash = createHash("sha256")
      .update(body)
      .digest("hex")
      .slice(0, 16);
    if (storedHash && storedHash !== computedHash) {
      log.warn(
        { id, stored: storedHash, computed: computedHash },
        "Memory entry content hash mismatch — possible tampering",
      );
    }

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
      source,
      sourceUrl,
      trustScore,
      contentHash: computedHash,
      author,
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
    const quarantinedEntries = this.list().filter(
      (m) => m.tier === "quarantine",
    );

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
      lines.push("");
    }
    if (quarantinedEntries.length > 0) {
      lines.push("## Quarantine (untrusted — review before use)\n");
      for (const m of quarantinedEntries) {
        lines.push(
          `- [${m.name}](quarantine/${m.id}.md) — ${m.description} [${m.source}, trust: ${m.trustScore.toFixed(1)}]`,
        );
      }
    }

    writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
  }

  /** Promote an entry to system tier (always in prompt). Quarantined entries require explicit trust override. */
  promote(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.tier === "system") return false;
    // Quarantined entries get trust bumped on explicit promotion
    const trustOverride =
      entry.tier === "quarantine" ? Math.max(entry.trustScore, 0.6) : undefined;
    return !!this.save({ ...entry, tier: "system", trustScore: trustOverride });
  }

  /** Demote a system entry to archive (index only). */
  demote(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.tier === "archive") return false;
    return !!this.save({ ...entry, tier: "archive" });
  }

  /** Quarantine an entry (remove from prompt, mark as untrusted). */
  quarantine(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.tier === "quarantine") return false;
    return !!this.save({
      ...entry,
      tier: "quarantine",
      trustScore: Math.min(entry.trustScore, 0.3),
    });
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
