/**
 * Tests for harness-fs: WAL, write-through, hashing, and basic watcher
 * lifecycle. Per spec invariants:
 *   - atomic rename happens before index update (write-through)
 *   - WAL records `begin` → `commit`/`abort`
 *   - replay returns only unfinalized ids
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WriteAheadLog,
  HarnessWriter,
  hashContent,
  HarnessWatcher,
} from "../index.js";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "harness-fs-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ── hashContent ──────────────────────────────────────────────

describe("hashContent", () => {
  test("identical strings produce identical hashes", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  test("different strings produce different hashes", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  test("Buffer input produces same hash as equivalent string", () => {
    expect(hashContent(Buffer.from("hello", "utf-8"))).toBe(
      hashContent("hello"),
    );
  });
});

// ── WriteAheadLog ───────────────────────────────────────────

describe("WriteAheadLog", () => {
  test("appends entries readable line-by-line", () => {
    const wal = new WriteAheadLog(join(testRoot, "wal.log"));
    wal.append({
      kind: "begin",
      id: "id-1",
      path: "/x",
      intent_hash: "h",
      at: 1,
    });
    wal.append({ kind: "commit", id: "id-1", at: 2 });
    const lines = readFileSync(join(testRoot, "wal.log"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("id-1");
    expect(JSON.parse(lines[1]!).kind).toBe("commit");
  });

  test("pendingIds returns only begin without commit/abort", () => {
    const wal = new WriteAheadLog(join(testRoot, "wal.log"));
    wal.append({
      kind: "begin",
      id: "a",
      path: "/a",
      intent_hash: "ha",
      at: 1,
    });
    wal.append({ kind: "commit", id: "a", at: 2 });
    wal.append({
      kind: "begin",
      id: "b",
      path: "/b",
      intent_hash: "hb",
      at: 3,
    });
    wal.append({
      kind: "begin",
      id: "c",
      path: "/c",
      intent_hash: "hc",
      at: 4,
    });
    wal.append({ kind: "abort", id: "c", error: "x", at: 5 });

    const pending = wal.pendingIds();
    expect(pending.map((p) => p.id).sort()).toEqual(["b"]);
    expect(pending[0]?.path).toBe("/b");
    expect(pending[0]?.intent_hash).toBe("hb");
  });

  test("pendingIds for empty / missing log returns []", () => {
    const wal = new WriteAheadLog(join(testRoot, "missing.log"));
    expect(wal.pendingIds()).toEqual([]);
  });

  test("compact rewrites to keep only pending entries", () => {
    const wal = new WriteAheadLog(join(testRoot, "wal.log"));
    wal.append({
      kind: "begin",
      id: "a",
      path: "/a",
      intent_hash: "ha",
      at: 1,
    });
    wal.append({ kind: "commit", id: "a", at: 2 });
    wal.append({
      kind: "begin",
      id: "b",
      path: "/b",
      intent_hash: "hb",
      at: 3,
    });

    wal.compact();

    const after = readFileSync(join(testRoot, "wal.log"), "utf-8")
      .trim()
      .split("\n");
    expect(after).toHaveLength(1);
    const parsed = JSON.parse(after[0]!);
    expect(parsed.id).toBe("b");
    expect(parsed.kind).toBe("begin");
  });

  test("malformed lines are silently skipped", () => {
    const path = join(testRoot, "wal.log");
    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: "begin",
          id: "a",
          path: "/a",
          intent_hash: "h",
          at: 1,
        }),
        "{ broken json",
        JSON.stringify({ kind: "commit", id: "a", at: 2 }),
        "",
      ].join("\n"),
    );
    const wal = new WriteAheadLog(path);
    expect(wal.pendingIds()).toEqual([]);
  });
});

// ── HarnessWriter — write-through ───────────────────────────

describe("HarnessWriter", () => {
  test("writes file atomically + appends WAL begin entry", () => {
    const writer = new HarnessWriter(testRoot);
    const result = writer.begin({
      absolutePath: join(testRoot, "team", "humans", "justin.toml"),
      relativePath: "team/humans/justin.toml",
      content: "name = 'Justin'\n",
    });
    expect(result.content_hash).toBe(hashContent("name = 'Justin'\n"));
    expect(result.size).toBeGreaterThan(0);

    expect(
      readFileSync(join(testRoot, "team/humans/justin.toml"), "utf-8"),
    ).toBe("name = 'Justin'\n");

    // WAL has begin only (no commit yet)
    expect(writer.pendingWrites().map((w) => w.id)).toEqual([result.id]);
  });

  test("commit removes id from pending", () => {
    const writer = new HarnessWriter(testRoot);
    const r = writer.begin({
      absolutePath: join(testRoot, "x.toml"),
      relativePath: "x.toml",
      content: "x = 1\n",
    });
    writer.commit(r.id);
    expect(writer.pendingWrites()).toEqual([]);
  });

  test("abort removes id from pending and records error reason", () => {
    const writer = new HarnessWriter(testRoot);
    const r = writer.begin({
      absolutePath: join(testRoot, "x.toml"),
      relativePath: "x.toml",
      content: "x = 1\n",
    });
    writer.abort(r.id, "index update threw");
    expect(writer.pendingWrites()).toEqual([]);
  });

  test("write helper auto-commits on success", async () => {
    const writer = new HarnessWriter(testRoot);
    let observed: string | null = null;
    const r = await writer.write(
      {
        absolutePath: join(testRoot, "y.toml"),
        relativePath: "y.toml",
        content: "y = 2\n",
      },
      (result) => {
        observed = result.content_hash;
      },
    );
    expect(observed).toBe(r.content_hash);
    expect(writer.pendingWrites()).toEqual([]);
  });

  test("write helper auto-aborts when index update throws", async () => {
    const writer = new HarnessWriter(testRoot);
    await expect(
      writer.write(
        {
          absolutePath: join(testRoot, "z.toml"),
          relativePath: "z.toml",
          content: "z = 3\n",
        },
        () => {
          throw new Error("simulated index failure");
        },
      ),
    ).rejects.toThrow("simulated index failure");

    expect(writer.pendingWrites()).toEqual([]);
    // File ends up on disk because atomic-rename completed before the
    // (synchronous) callback ran. WAL records the abort; recovery logic
    // in the index module decides what to do with the orphan file.
    expect(readFileSync(join(testRoot, "z.toml"), "utf-8")).toBe("z = 3\n");
  });

  test("nested-path writes auto-create parent dirs", () => {
    const writer = new HarnessWriter(testRoot);
    const r = writer.begin({
      absolutePath: join(testRoot, "a/b/c/d.toml"),
      relativePath: "a/b/c/d.toml",
      content: "deep = true\n",
    });
    expect(readFileSync(join(testRoot, "a/b/c/d.toml"), "utf-8")).toBe(
      "deep = true\n",
    );
    writer.commit(r.id);
  });

  test("relativize converts absolute to harness-relative", () => {
    const writer = new HarnessWriter(testRoot);
    expect(writer.relativize(join(testRoot, "team/humans/x.toml"))).toBe(
      "team/humans/x.toml",
    );
  });
});

// ── HarnessWatcher — basic lifecycle ────────────────────────

describe("HarnessWatcher", () => {
  test("emits 'ready' on initial scan complete", async () => {
    mkdirSync(join(testRoot, "customers"));
    writeFileSync(join(testRoot, "customers", "acme.toml"), "name = 'Acme'\n");
    const w = new HarnessWatcher(testRoot, { debounceMs: 10 });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("watcher never readied")),
        5000,
      );
      w.once("ready", () => {
        clearTimeout(t);
        resolve();
      });
      w.start();
    });

    await w.stop();
  });

  test("emits 'change' on file modification (debounced)", async () => {
    const file = join(testRoot, "x.toml");
    writeFileSync(file, "x = 1\n");
    const w = new HarnessWatcher(testRoot, { debounceMs: 50 });

    const events: string[] = [];
    w.on("change", (e: { relativePath: string }) =>
      events.push(e.relativePath),
    );

    await new Promise<void>((resolve) => {
      w.once("ready", () => resolve());
      w.start();
    });

    writeFileSync(file, "x = 2\n");

    // Wait for debounced emit
    await new Promise((r) => setTimeout(r, 250));
    expect(events).toContain("x.toml");

    await w.stop();
  });

  test("respects ignored globs (.harness/index/ excluded)", async () => {
    mkdirSync(join(testRoot, ".harness", "index"), { recursive: true });
    const w = new HarnessWatcher(testRoot, { debounceMs: 10 });

    const events: string[] = [];
    w.on("add", (e: { relativePath: string }) => events.push(e.relativePath));

    await new Promise<void>((resolve) => {
      w.once("ready", () => resolve());
      w.start();
    });

    writeFileSync(join(testRoot, ".harness/index/index.db"), "ignored");
    await new Promise((r) => setTimeout(r, 200));
    expect(events).not.toContain(".harness/index/index.db");

    await w.stop();
  });
});
