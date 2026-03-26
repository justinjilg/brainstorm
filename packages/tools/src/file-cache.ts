/**
 * LRU file read cache with TTL-based expiry.
 * Reduces redundant disk reads during agent loops that re-read the same files.
 * Invalidated on write via invalidate().
 */

interface CacheEntry {
  content: string;
  cachedAt: number;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class FileReadCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(path: string): string | null {
    const entry = this.cache.get(path);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(path);
      return null;
    }
    // Move to end for LRU ordering
    this.cache.delete(path);
    this.cache.set(path, entry);
    return entry.content;
  }

  set(path: string, content: string): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(path, { content, cachedAt: Date.now() });
  }

  /** Invalidate a single path (e.g., after write/edit). */
  invalidate(path: string): void {
    this.cache.delete(path);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

let _instance: FileReadCache | null = null;

export function getFileReadCache(): FileReadCache {
  if (!_instance) _instance = new FileReadCache();
  return _instance;
}

export function resetFileReadCache(): void {
  _instance?.clear();
  _instance = null;
}
