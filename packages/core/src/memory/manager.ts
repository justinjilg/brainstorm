import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export interface MemoryEntry {
  id: string;
  type: 'user' | 'project' | 'feedback' | 'reference';
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
 * When BR SaaS is available, memory syncs to cloud RMM for
 * cross-device/cross-agent recall. Local SQLite as fallback.
 */
export class MemoryManager {
  private memoryDir: string;
  private indexPath: string;
  private entries: Map<string, MemoryEntry> = new Map();

  constructor(projectPath: string) {
    const projectHash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
    this.memoryDir = join(homedir(), '.brainstorm', 'projects', projectHash, 'memory');
    this.indexPath = join(this.memoryDir, 'MEMORY.md');
    mkdirSync(this.memoryDir, { recursive: true });
    this.loadAll();
  }

  /** Save a memory entry. Creates or updates the file. */
  save(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
    const id = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
      '---',
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      '---',
      '',
      memory.content,
    ].join('\n');
    writeFileSync(filePath, fileContent, 'utf-8');

    this.entries.set(id, memory);
    this.updateIndex();
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
    try { writeFileSync(filePath, '', 'utf-8'); } catch {}
    this.updateIndex();
    return true;
  }

  /** Get context string for injection into system prompt (first 200 lines of index). */
  getContextString(): string {
    if (!existsSync(this.indexPath)) return '';
    const content = readFileSync(this.indexPath, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(0, 200).join('\n');
  }

  /** Search memories by keyword. */
  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.list().filter((m) =>
      m.name.toLowerCase().includes(lower) ||
      m.description.toLowerCase().includes(lower) ||
      m.content.toLowerCase().includes(lower)
    );
  }

  private loadAll(): void {
    if (!existsSync(this.memoryDir)) return;
    const files = readdirSync(this.memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');

    for (const file of files) {
      try {
        const content = readFileSync(join(this.memoryDir, file), 'utf-8');
        const entry = this.parseMemoryFile(file, content);
        if (entry) this.entries.set(entry.id, entry);
      } catch {}
    }
  }

  private parseMemoryFile(filename: string, content: string): MemoryEntry | null {
    const id = filename.replace('.md', '');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const body = fmMatch[2].trim();

    const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() ?? id;
    const description = fm.match(/description:\s*(.+)/)?.[1]?.trim() ?? '';
    const type = (fm.match(/type:\s*(.+)/)?.[1]?.trim() ?? 'project') as MemoryEntry['type'];

    return {
      id, name, description, type, content: body,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }

  private updateIndex(): void {
    const lines = this.list().map((m) =>
      `- [${m.name}](${m.id}.md) — ${m.description}`
    );
    writeFileSync(this.indexPath, lines.join('\n') + '\n', 'utf-8');
  }
}
