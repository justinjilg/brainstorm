import { describe, it, expect } from "vitest";
import {
  beginTransactionTool,
  commitTransactionTool,
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
