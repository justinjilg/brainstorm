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
import { createLogger, atomicWriteFile } from "@brainst0rm/shared";
import type { BrainstormGateway } from "@brainst0rm/gateway";
import { initMemoryRepo, commitMemoryChange } from "./git.js";
import type { GitMemorySync } from "./git-sync.js";

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
  /** Temporal validity — when this fact became true. Omit for timeless entries. */
  validFrom?: number;
  /** Temporal validity — when this fact stopped being true. Omit if still current. */
  validUntil?: number;
  /** Project path this entry belongs to (for cross-project indexing). */
  projectPath?: string;
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
// Default 100KB — raised from 25KB after assessment found it insufficient for
// large codebases. Configurable via BRAINSTORM_MEMORY_CAP_KB env var.
const MAX_MEMORY_BYTES =
  (parseInt(process.env.BRAINSTORM_MEMORY_CAP_KB ?? "100", 10) || 100) * 1024;
/** Token budget for system tier (always-loaded context). ~4 chars per token.
 * Raised from 800 to 2000 to support richer project expertise from onboarding. */
const SYSTEM_TIER_TOKEN_BUDGET = 2000;
/** Rough token estimation: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryManager {
  private memoryDir: string;
  private systemDir: string;
  private quarantineDir: string;
  private indexPath: string;
  private entries: Map<string, MemoryEntry> = new Map();
  private indexDirty = false;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private gateway: BrainstormGateway | null;
  private projectSlug: string;
  private pullState: "idle" | "running" | "completed" | "failed" = "idle";
  private lastPullAt: number | null = null;
  private lastPullError: string | null = null;
  private _sessionMemoryOps = 0;
  private gitSync: GitMemorySync | null = null;

  constructor(
    projectPath: string,
    gateway?: BrainstormGateway | null,
    gitSync?: GitMemorySync | null,
  ) {
    this.gateway = gateway ?? null;
    this.gitSync = gitSync ?? null;
    const projectHash = createHash("sha256")
      .update(projectPath)
      .digest("hex")
      .slice(0, 16);
    // Project slug for BR: use basename (e.g. "hawktalk") not the full path,
    // so teammates on different machines share the same project scope.
    // Fall back to the 16-char hash if basename collides or is empty.
    this.projectSlug =
      projectPath.split("/").filter(Boolean).pop() ?? projectHash;
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

    // An existing entry with the same slug but a *different* original name
    // means two semantically distinct memories want the same ID. Historically
    // the second save would overwrite the first's on-disk file under "update"
    // semantics and the first entry's content was silently lost. Surface the
    // collision instead so the caller can pick a less ambiguous name.
    if (existing && existing.name !== entry.name) {
      throw new Error(
        `Memory slug collision: "${entry.name}" and "${existing.name}" both slugify to "${id}". Rename one to disambiguate.`,
      );
    }

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
    } else if (source === "web_fetch" && trustScore < 0.7) {
      // Block ALL web-sourced entries from system tier unless high trust,
      // regardless of whether tier was explicitly set or auto-derived.
      tier = entry.tier === "system" ? "archive" : (entry.tier ?? "archive");
      if (entry.tier === "system") {
        log.warn(
          { id, source, trustScore },
          "Web-sourced entry blocked from system tier — demoted to archive",
        );
      }
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
    if (memory.validFrom) fmLines.push(`validFrom: ${memory.validFrom}`);
    if (memory.validUntil) fmLines.push(`validUntil: ${memory.validUntil}`);
    if (memory.projectPath) fmLines.push(`projectPath: ${memory.projectPath}`);
    fmLines.push("---", "", memory.content);
    const fileContent = fmLines.join("\n");

    // Pre-check capacity — reject entries that would exceed the limit
    const currentSize = this.estimateTotalSize();
    if (currentSize + fileContent.length > MAX_MEMORY_BYTES) {
      this.enforceCapacity(); // Try pruning first
      if (this.estimateTotalSize() + fileContent.length > MAX_MEMORY_BYTES) {
        log.warn(
          { id, size: fileContent.length, cap: MAX_MEMORY_BYTES },
          "Memory entry exceeds capacity — rejected",
        );
        return memory; // Return without writing
      }
    }

    atomicWriteFile(filePath, fileContent);

    this.entries.set(id, memory);
    this._sessionMemoryOps++;
    this.scheduleIndexUpdate();

    // Cross-process concurrency: another CLI process may have written its
    // own entry between our pre-check and this write, pushing us over the
    // soft cap. Re-check and evict now so the overflow doesn't linger
    // until the next save() call.
    if (this.estimateTotalSize() > MAX_MEMORY_BYTES) {
      this.enforceCapacity();
    }

    // Fire-and-forget push to gateway, now with project scope so
    // teammates sharing the same project see each other's entries
    // without cross-project pollution. See docs/br-capability-audit.md
    // for why project scope matters.
    //
    // Quarantine tier is NEVER pushed to the gateway — low-trust
    // content stays machine-local only, as designed.
    if (this.gateway && tier !== "quarantine") {
      this.gateway
        .storeMemory(
          memory.type,
          `[${memory.name}] ${memory.content}`,
          this.projectSlug,
        )
        .catch((e) => {
          log.warn(
            { err: e, memoryId: id },
            "Failed to push memory to gateway",
          );
        });
    }

    // Git-track the change
    const commitMsg = `memory: ${existing ? "update" : "create"} ${memory.name}`;
    commitMemoryChange(this.memoryDir, commitMsg);

    // Push to git remote if configured
    if (this.gitSync) {
      this.gitSync.syncAfterWrite(commitMsg);
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

  /**
   * Pull remote memory entries from BR and merge with local.
   *
   * This closes the cross-machine sync loop — without it, local writes
   * push to BR (fire-and-forget) but remote writes never come back, so
   * two machines diverge over time. Now on construction, callers can
   * invoke this to fetch whatever BR has for the current project and
   * merge into the local store.
   *
   * Merge strategy: **additive last-writer-wins by name**.
   *   1. For every remote entry that doesn't exist locally, create it.
   *   2. For every remote entry whose local counterpart is older
   *      (by updatedAt timestamp), overwrite the local copy.
   *   3. Local entries that don't exist remotely are NOT deleted —
   *      the CLI's explicit `forget` is the only delete path.
   *
   * The merge never touches the quarantine tier: low-trust entries
   * stay machine-local on both the push and pull sides.
   *
   * This method is fire-and-forget from the caller's perspective: it
   * returns a promise but errors are captured into pullState/lastPullError
   * rather than thrown. That way the constructor can kick off a pull
   * without worrying about unhandled rejections, and the CLI can show
   * the sync state via getPullStatus().
   */
  async pullFromGateway(): Promise<{
    pulled: number;
    created: number;
    updated: number;
    skipped: number;
  }> {
    if (!this.gateway) {
      return { pulled: 0, created: 0, updated: 0, skipped: 0 };
    }
    if (this.pullState === "running") {
      return { pulled: 0, created: 0, updated: 0, skipped: 0 };
    }
    this.pullState = "running";

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let pulled = 0;

    try {
      const remote = await this.gateway.listMemory(this.projectSlug);
      pulled = remote.length;

      for (const rem of remote) {
        // BR's MemoryEntry has: { id, block, content, created_at }.
        // Some tenant configurations may also expose updated_at; we
        // cast through `any` to read both safely. The push path encodes
        // "[name] content" in the content field, so parse it back.
        const remAny = rem as any;
        const name = this.extractNameFromBRContent(rem.content);
        if (!name) {
          skipped++;
          continue;
        }
        const localId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const existing = this.entries.get(localId);

        // BR timestamps arrive as ISO strings or unix — coerce to unix.
        // Fall back to created_at if updated_at is absent.
        const remoteUpdatedAt =
          this.coerceTimestamp(remAny.updatedAt) ??
          this.coerceTimestamp(remAny.updated_at) ??
          this.coerceTimestamp(remAny.createdAt) ??
          this.coerceTimestamp(remAny.created_at);

        if (!existing) {
          // New entry — create it, but via the save path so trust scoring,
          // tier selection, and file write all go through the existing
          // logic. Mark source as "gateway" so trust defaults apply.
          this.save({
            name,
            description: rem.content.slice(0, 100),
            type: (rem.block as MemoryEntry["type"]) ?? "reference",
            content: this.stripNameFromBRContent(rem.content),
            source: "gateway" as any,
          });
          created++;
          continue;
        }

        // Existing entry — overwrite only if remote is newer
        if (remoteUpdatedAt !== null && remoteUpdatedAt > existing.updatedAt) {
          this.save({
            name: existing.name,
            description: existing.description,
            type: existing.type,
            content: this.stripNameFromBRContent(rem.content),
            source: existing.source,
            tier: existing.tier,
            trustScore: existing.trustScore,
          });
          updated++;
        } else {
          skipped++;
        }
      }

      this.pullState = "completed";
      this.lastPullAt = Math.floor(Date.now() / 1000);
      this.lastPullError = null;

      if (created > 0 || updated > 0) {
        log.info(
          { pulled, created, updated, skipped, project: this.projectSlug },
          "Memory pulled from gateway",
        );
      }
    } catch (e: any) {
      this.pullState = "failed";
      this.lastPullError = e?.message ?? String(e);
      log.warn({ err: e }, "Memory pull from gateway failed");
    }

    return { pulled, created, updated, skipped };
  }

  /** Get the current pull status — for `brainstorm sync status` CLI. */
  getPullStatus(): {
    state: "idle" | "running" | "completed" | "failed";
    lastPullAt: number | null;
    lastError: string | null;
  } {
    return {
      state: this.pullState,
      lastPullAt: this.lastPullAt,
      lastError: this.lastPullError,
    };
  }

  /**
   * Parse a name out of BR content that the push path encoded as
   * "[name] content body". Returns null if no bracket prefix found.
   */
  private extractNameFromBRContent(content: string): string | null {
    const match = content.match(/^\[([^\]]+)\]\s*/);
    return match?.[1] ?? null;
  }

  /** Strip the "[name] " prefix from BR content. */
  private stripNameFromBRContent(content: string): string {
    return content.replace(/^\[([^\]]+)\]\s*/, "");
  }

  /** Coerce BR's updatedAt (ISO string, unix number, or undefined) to unix seconds. */
  private coerceTimestamp(value: unknown): number | null {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
    return null;
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
    const deleteMsg = `memory: delete ${entry.name}`;
    commitMemoryChange(this.memoryDir, deleteMsg);
    if (this.gitSync) {
      this.gitSync.syncAfterWrite(deleteMsg);
    }
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
    const now = Math.floor(Date.now() / 1000);

    // Filter out expired entries (validUntil in the past)
    const active = this.list().filter(
      (m) => !m.validUntil || m.validUntil > now,
    );

    const systemEntries = active.filter((m) => m.tier === "system");
    const archiveEntries = active.filter((m) => m.tier === "archive");
    const quarantinedEntries = active.filter((m) => m.tier === "quarantine");

    // Token-budgeted system tier: sort by trust (highest first), include until budget exhausted
    if (systemEntries.length > 0) {
      parts.push("### Active Memory (always loaded)\n");
      const sorted = [...systemEntries].sort(
        (a, b) => b.trustScore - a.trustScore,
      );
      let tokenBudget = SYSTEM_TIER_TOKEN_BUDGET;
      let included = 0;
      const overflowed: MemoryEntry[] = [];

      for (const m of sorted) {
        const block = `**${m.name}** (${m.type}): ${m.description}\n${m.content}\n`;
        const tokens = estimateTokens(block);
        if (tokenBudget - tokens >= 0) {
          const trustTag =
            m.source !== "user_input"
              ? ` [source: ${m.source}, trust: ${m.trustScore.toFixed(1)}]`
              : "";
          parts.push(`**${m.name}** (${m.type})${trustTag}: ${m.description}`);
          parts.push(m.content);
          parts.push("");
          tokenBudget -= tokens;
          included++;
        } else {
          overflowed.push(m);
        }
      }

      // Overflow entries shown as index-only (like archive)
      if (overflowed.length > 0) {
        parts.push(
          `> ${overflowed.length} system entries exceeded token budget — showing as index:\n`,
        );
        for (const m of overflowed) {
          parts.push(`- **${m.name}** — ${m.description}`);
        }
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

  /** Number of save() calls this session — used to gate curator cycle. */
  getSessionMemoryOps(): number {
    return this._sessionMemoryOps;
  }

  /** Reset session counter (call at session start). */
  resetSessionOps(): void {
    this._sessionMemoryOps = 0;
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
    // Pull from git remote before loading (rate-limited internally)
    if (this.gitSync) {
      this.gitSync.syncBeforeRead();
    }
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
    const validFrom =
      parseInt(fm.match(/validFrom:\s*(.+)/)?.[1]?.trim() ?? "") || undefined;
    const validUntil =
      parseInt(fm.match(/validUntil:\s*(.+)/)?.[1]?.trim() ?? "") || undefined;
    const projectPath = fm.match(/projectPath:\s*(.+)/)?.[1]?.trim();

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
      validFrom,
      validUntil,
      projectPath,
      createdAt: mtime,
      updatedAt: mtime,
    };
  }

  /**
   * Enforce memory directory size cap via LRU eviction.
   * Evicts oldest entries (by updatedAt) until total size is under MAX_MEMORY_BYTES.
   * Entries with "[keep]" in their name are exempt from eviction.
   */
  private estimateTotalSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total +=
        entry.content.length +
        entry.name.length +
        entry.description.length +
        200; // 200 for frontmatter
    }
    return total;
  }

  private enforceCapacity(): void {
    // Scan ALL memory directories — root, system/, and quarantine/ — to prevent
    // unbounded growth in subdirectories that were previously not counted.
    const dirs: Array<{ dir: string; prefix: string }> = [
      { dir: this.memoryDir, prefix: "" },
      { dir: this.systemDir, prefix: "system/" },
      { dir: this.quarantineDir, prefix: "quarantine/" },
    ];
    let totalBytes = 0;
    const fileSizes: Array<{
      id: string;
      fullPath: string;
      bytes: number;
      updatedAt: number;
    }> = [];

    for (const { dir } of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir).filter(
          (f) => f.endsWith(".md") && f !== "MEMORY.md",
        );
      } catch {
        continue; // Directory may not exist yet
      }
      for (const file of files) {
        const filePath = join(dir, file);
        try {
          const bytes = statSync(filePath).size;
          totalBytes += bytes;
          const id = file.replace(".md", "");
          const entry = this.entries.get(id);
          fileSizes.push({
            id,
            fullPath: filePath,
            bytes,
            updatedAt: entry?.updatedAt ?? 0,
          });
        } catch {
          /* file may have been deleted concurrently */
        }
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

      try {
        unlinkSync(entry.fullPath);
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

  /**
   * Dispose — cancel pending timers and flush any dirty index.
   * MUST be called before process exit or test teardown to prevent
   * the ENOENT timer leak (the timer fires into a cleaned-up directory).
   */
  dispose(): void {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    // Flush synchronously if dirty — prevents data loss on SIGKILL
    if (this.indexDirty) {
      try {
        this.flushIndex();
      } catch {
        // Directory may already be removed (test teardown) — safe to ignore
      }
    }
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

    try {
      writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
    } catch {
      // Directory may have been removed (test teardown, process cleanup).
      // This is expected — the index is a convenience file, not critical data.
    }
  }

  /** Promote an entry to system tier (always in prompt). Quarantined entries cannot be promoted without explicit user trust override. */
  promote(id: string, userConfirmed = false): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.tier === "system") return false;
    // Quarantined entries cannot be auto-promoted — requires user confirmation
    // to prevent memory poisoning: web fetch → agent_extraction → promote → system tier
    if (entry.tier === "quarantine" && !userConfirmed) return false;
    const trustOverride =
      entry.tier === "quarantine" && userConfirmed
        ? Math.max(entry.trustScore, 0.6)
        : undefined;
    return !!this.save({ ...entry, tier: "system", trustScore: trustOverride });
  }

  /** Mark a memory entry as no longer current (sets validUntil to now). */
  invalidate(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    return !!this.save({
      ...entry,
      validUntil: Math.floor(Date.now() / 1000),
    });
  }

  /** Query memories that were valid at a specific point in time. */
  asOf(timestamp: number): MemoryEntry[] {
    return this.list().filter((m) => {
      if (m.validFrom && m.validFrom > timestamp) return false;
      if (m.validUntil && m.validUntil < timestamp) return false;
      return true;
    });
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

  /**
   * Update the global cross-project memory index.
   * Writes concept → project mappings to ~/.brainstorm/memory-index.json.
   * Enables pattern discovery across projects ("auth" appears in 3 projects).
   */
  updateGlobalIndex(projectName: string): void {
    const globalIndexPath = join(homedir(), ".brainstorm", "memory-index.json");
    let index: Record<string, string[]> = {};
    try {
      if (existsSync(globalIndexPath)) {
        index = JSON.parse(readFileSync(globalIndexPath, "utf-8"));
      }
    } catch {
      index = {};
    }

    // Extract concepts from this project's memories
    for (const entry of this.list()) {
      // Use entry name + type as concept keys
      const concepts = [
        entry.name.toLowerCase(),
        entry.type,
        ...(entry.description ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter((w: string) => w.length > 4),
      ];
      for (const concept of concepts) {
        if (!index[concept]) index[concept] = [];
        if (!index[concept].includes(projectName)) {
          index[concept].push(projectName);
        }
      }
    }

    try {
      // atomicWriteFile — write-to-temp then rename, so a crash
      // mid-write never leaves a partially-written index that the
      // next JSON.parse() would reject. Prior plain writeFileSync
      // left that gap; the parse catch above silently reset the
      // index to {} on the first successful re-read, losing every
      // concept the partial-write instance had merged in.
      atomicWriteFile(globalIndexPath, JSON.stringify(index, null, 2));
    } catch (e) {
      log.warn({ err: e }, "Failed to update global memory index");
    }
  }

  /**
   * Find concepts that appear across multiple projects (tunnels).
   * Returns concepts sorted by how many projects share them.
   */
  static getCrossProjectConcepts(): Array<{
    concept: string;
    projects: string[];
  }> {
    const globalIndexPath = join(homedir(), ".brainstorm", "memory-index.json");
    try {
      if (!existsSync(globalIndexPath)) return [];
      const index: Record<string, string[]> = JSON.parse(
        readFileSync(globalIndexPath, "utf-8"),
      );
      return Object.entries(index)
        .filter(([, projects]) => projects.length > 1)
        .map(([concept, projects]) => ({ concept, projects }))
        .sort((a, b) => b.projects.length - a.projects.length);
    } catch {
      return [];
    }
  }
}

/**
 * Semantic search using TF-IDF with BM25 scoring.
 * Significantly better than simple keyword matching for memory retrieval.
 */
export function searchMemoriesBM25(
  entries: MemoryEntry[],
  query: string,
  k = 10,
): MemoryEntry[] {
  if (entries.length === 0 || !query.trim()) return [];

  const queryTerms = query
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (queryTerms.length === 0) return [];

  // BM25 parameters
  const k1 = 1.2;
  const b = 0.75;

  // Build document frequency map
  const df: Record<string, number> = {};
  const docs = entries.map((e) => {
    const text = `${e.name} ${e.description} ${e.content}`.toLowerCase();
    const terms = text.replace(/[^a-z0-9_]+/g, " ").split(/\s+/);
    const tf: Record<string, number> = {};
    for (const t of terms) {
      tf[t] = (tf[t] ?? 0) + 1;
      if (tf[t] === 1) df[t] = (df[t] ?? 0) + 1;
    }
    return { entry: e, tf, length: terms.length };
  });

  const avgDl = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const N = docs.length;

  const scored = docs.map(({ entry, tf, length }) => {
    let score = 0;
    for (const term of queryTerms) {
      const termFreq = tf[term] ?? 0;
      if (termFreq === 0) continue;
      const idf = Math.log(
        (N - (df[term] ?? 0) + 0.5) / ((df[term] ?? 0) + 0.5) + 1,
      );
      score +=
        idf *
        ((termFreq * (k1 + 1)) /
          (termFreq + k1 * (1 - b + b * (length / avgDl))));
    }
    // Trust boost: higher trust entries rank slightly higher
    score *= 0.8 + 0.2 * entry.trustScore;
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.entry);
}
