import { describe, it, expect } from "vitest";
import { getFileTracker, resetFileTracker } from "../file-tracker.js";
import {
  getToolHealthTracker,
  resetToolHealthTracker,
} from "../tool-health.js";
import { withSession } from "../session-context.js";

describe("file/tool-health trackers — concurrent session isolation", () => {
  it("keeps two sessions' file-access history separate", async () => {
    withSession("ft-A", () => getFileTracker().recordRead("/a/one.ts"));
    withSession("ft-B", () => getFileTracker().recordWrite("/b/two.ts"));

    // await resolves withSession's `T | Promise<T>` return to `T`.
    const a = await withSession("ft-A", () => getFileTracker().getManifest());
    const b = await withSession("ft-B", () => getFileTracker().getManifest());
    expect(a.reads).toEqual(["/a/one.ts"]);
    expect(a.writes).toEqual([]);
    expect(b.writes).toEqual(["/b/two.ts"]);
    expect(b.reads).toEqual([]);

    resetFileTracker("ft-A");
    resetFileTracker("ft-B");
  });

  it("keeps two sessions' tool-health stats separate", async () => {
    withSession("th-A", () => {
      const t = getToolHealthTracker();
      for (let i = 0; i < 5; i++) t.recordFailure("shell", "boom");
    });
    // Session B's shell health is unaffected by A's failures.
    const bUnhealthy = await withSession("th-B", () =>
      getToolHealthTracker().getUnhealthy(),
    );
    expect(bUnhealthy).toEqual([]);

    resetToolHealthTracker("th-A");
    resetToolHealthTracker("th-B");
  });
});
