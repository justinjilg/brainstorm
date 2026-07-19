import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginTransactionTool,
  commitTransactionTool,
  rollbackTransactionTool,
  isTransactionActive,
  recordTransactionFile,
  getTransactionFiles,
} from "../builtin/transaction.js";
import { withSession } from "../session-context.js";

describe("transaction state — concurrent session isolation", () => {
  it("keeps two sessions' transactions independent", async () => {
    // Session A opens a transaction; session B must see NO active transaction.
    await withSession("tx-A", () => beginTransactionTool.execute({}));

    const bActiveWhileAOpen = await withSession("tx-B", () =>
      isTransactionActive(),
    );
    const aActive = await withSession("tx-A", () => isTransactionActive());
    expect(aActive).toBe(true);
    expect(bActiveWhileAOpen).toBe(false);

    // B can open its OWN transaction (not blocked by A's global flag).
    const bBegin = await withSession("tx-B", () =>
      beginTransactionTool.execute({}),
    );
    expect(bBegin).toMatchObject({ success: true });
  });

  it("tracks files against the recording session only", async () => {
    await withSession("tx-C", () => beginTransactionTool.execute({}));
    await withSession("tx-D", () => beginTransactionTool.execute({}));

    await withSession("tx-C", () => recordTransactionFile("/c/only.ts"));

    const cFiles = await withSession("tx-C", () => getTransactionFiles());
    const dFiles = await withSession("tx-D", () => getTransactionFiles());
    expect(cFiles).toEqual(["/c/only.ts"]);
    expect(dFiles).toEqual([]);
  });

  it("committing one session does not disturb another's open transaction", async () => {
    await withSession("tx-E", () => beginTransactionTool.execute({}));
    await withSession("tx-F", () => beginTransactionTool.execute({}));
    await withSession("tx-F", () => recordTransactionFile("/f/x.ts"));

    // E commits (empty); F's transaction must remain active with its file.
    await withSession("tx-E", () => commitTransactionTool.execute({}));

    const eActive = await withSession("tx-E", () => isTransactionActive());
    const fActive = await withSession("tx-F", () => isTransactionActive());
    const fFiles = await withSession("tx-F", () => getTransactionFiles());
    expect(eActive).toBe(false);
    expect(fActive).toBe(true);
    expect(fFiles).toEqual(["/f/x.ts"]);
  });
});

describe("transaction — cleanup + rollback safety (005.6 hardening)", () => {
  it("releases state on commit (read paths don't resurrect an active tx)", async () => {
    await withSession("tx-G", () => beginTransactionTool.execute({}));
    expect(await withSession("tx-G", () => isTransactionActive())).toBe(true);

    await withSession("tx-G", () => commitTransactionTool.execute({}));
    // After commit: not active, and a fresh begin works (state was released).
    expect(await withSession("tx-G", () => isTransactionActive())).toBe(false);
    const reBegin = await withSession("tx-G", () =>
      beginTransactionTool.execute({}),
    );
    expect(reBegin).toMatchObject({ success: true });
    await withSession("tx-G", () => commitTransactionTool.execute({}));
  });

  it("refuses to roll back a file a concurrent edit changed since the last write", async () => {
    const { initCheckpointManager } = await import("../checkpoint.js");
    const { withSession: ws } = await import("../session-context.js");
    const dir = mkdtempSync(join(tmpdir(), "tx-rollback-"));
    const file = join(dir, "shared.ts");

    await ws("tx-H", async () => {
      initCheckpointManager("tx-H");
      const { getCheckpointManager } = await import("../checkpoint.js");
      writeFileSync(file, "original\n");
      // Snapshot (as file-write would), then write the transaction's version.
      getCheckpointManager()!.snapshot(file);
      await beginTransactionTool.execute({});
      writeFileSync(file, "transaction-version\n");
      recordTransactionFile(file); // records hash of "transaction-version"

      // A concurrent session edits the same file AFTER our write.
      writeFileSync(file, "someone-elses-committed-work\n");

      const result = await rollbackTransactionTool.execute({});
      // The divergence must be refused, not silently clobbered.
      expect((result as any).filesFailed.length).toBe(1);
      expect((result as any).filesFailed[0].error).toContain("concurrent edit");
      // The other session's work survives.
      expect(readFileSync(file, "utf-8")).toBe("someone-elses-committed-work\n");
    });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("transaction rollback — atomic hash + unverifiable safety (Codex 005.6 a)", () => {
  it("refuses rollback when the file is unverifiable (no recorded hash)", async () => {
    const { initCheckpointManager } = await import("../checkpoint.js");
    const { withSession: ws } = await import("../session-context.js");
    const dir = mkdtempSync(join(tmpdir(), "tx-unverif-"));
    const file = join(dir, "x.ts");

    await ws("tx-U", async () => {
      initCheckpointManager("tx-U");
      const { getCheckpointManager } = await import("../checkpoint.js");
      writeFileSync(file, "v1\n");
      getCheckpointManager()!.snapshot(file);
      await beginTransactionTool.execute({});
      writeFileSync(file, "v2\n");
      // Record with an EMPTY hash → unverifiable.
      recordTransactionFile(file, "");

      const result = await rollbackTransactionTool.execute({});
      expect((result as any).filesFailed[0].error).toContain("unverifiable");
      // File untouched (not reverted).
      expect(readFileSync(file, "utf-8")).toBe("v2\n");
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("reverts cleanly when the recorded hash matches (no concurrent edit)", async () => {
    const { createHash } = await import("node:crypto");
    const { initCheckpointManager } = await import("../checkpoint.js");
    const { withSession: ws } = await import("../session-context.js");
    const dir = mkdtempSync(join(tmpdir(), "tx-clean-"));
    const file = join(dir, "y.ts");

    await ws("tx-V", async () => {
      initCheckpointManager("tx-V");
      const { getCheckpointManager } = await import("../checkpoint.js");
      writeFileSync(file, "original\n");
      getCheckpointManager()!.snapshot(file);
      await beginTransactionTool.execute({});
      const written = "changed\n";
      writeFileSync(file, written);
      // Atomic hash of the bytes we wrote (what file_write passes).
      recordTransactionFile(
        file,
        createHash("sha256").update(written).digest("hex"),
      );

      const result = await rollbackTransactionTool.execute({});
      expect((result as any).filesFailed).toHaveLength(0);
      // Reverted to the snapshot.
      expect(readFileSync(file, "utf-8")).toBe("original\n");
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
