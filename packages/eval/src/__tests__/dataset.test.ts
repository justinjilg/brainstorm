import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadVerifiedDataset,
  loadVerifiedSubset,
  selectDeterministicSubset,
  validateRecord,
  DatasetValidationError,
  type SWEBenchVerifiedInstance,
} from "../swe-bench/dataset.js";

function fixtureRecord(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: "astropy__astropy-1234",
    repo: "astropy/astropy",
    base_commit: "abc1234",
    patch: "diff --git a/x.py b/x.py\n+fix",
    test_patch: "diff --git a/test_x.py b/test_x.py\n+test",
    problem_statement: "Something is broken.",
    FAIL_TO_PASS: '["tests/test_x.py::test_fix"]',
    PASS_TO_PASS: '["tests/test_x.py::test_other"]',
    ...overrides,
  };
}

function writeFixtureJsonl(records: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "swe-bench-dataset-"));
  const path = join(dir, "verified.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

describe("validateRecord", () => {
  it("parses a valid record into a SWEBenchVerifiedInstance", () => {
    const instance = validateRecord(fixtureRecord(), 1);
    expect(instance).toEqual<SWEBenchVerifiedInstance>({
      instanceId: "astropy__astropy-1234",
      repo: "astropy/astropy",
      baseCommit: "abc1234",
      issue: "Something is broken.",
      hints: undefined,
      testPatch: "diff --git a/test_x.py b/test_x.py\n+test",
      failToPass: ["tests/test_x.py::test_fix"],
      passToPass: ["tests/test_x.py::test_other"],
      goldPatch: "diff --git a/x.py b/x.py\n+fix",
    });
  });

  it("parses FAIL_TO_PASS/PASS_TO_PASS already given as arrays", () => {
    const instance = validateRecord(
      fixtureRecord({
        FAIL_TO_PASS: ["a::b"],
        PASS_TO_PASS: ["c::d"],
      }),
      1,
    );
    expect(instance.failToPass).toEqual(["a::b"]);
    expect(instance.passToPass).toEqual(["c::d"]);
  });

  it("defaults missing FAIL_TO_PASS/PASS_TO_PASS to empty arrays", () => {
    const record = fixtureRecord();
    delete (record as any).FAIL_TO_PASS;
    delete (record as any).PASS_TO_PASS;
    const instance = validateRecord(record, 1);
    expect(instance.failToPass).toEqual([]);
    expect(instance.passToPass).toEqual([]);
  });

  it("throws DatasetValidationError when a required field is missing", () => {
    const record = fixtureRecord();
    delete (record as any).base_commit;
    expect(() => validateRecord(record, 5)).toThrow(DatasetValidationError);
    expect(() => validateRecord(record, 5)).toThrow(/line 5/);
  });

  it("throws DatasetValidationError when a required field is empty", () => {
    const record = fixtureRecord({ problem_statement: "" });
    expect(() => validateRecord(record, 2)).toThrow(DatasetValidationError);
  });

  it("throws DatasetValidationError for non-object input", () => {
    expect(() => validateRecord("not an object", 1)).toThrow(
      DatasetValidationError,
    );
    expect(() => validateRecord(null, 1)).toThrow(DatasetValidationError);
  });
});

describe("loadVerifiedDataset", () => {
  it("loads and validates every line of a JSONL fixture", () => {
    const path = writeFixtureJsonl([
      fixtureRecord({ instance_id: "repo__repo-1" }),
      fixtureRecord({ instance_id: "repo__repo-2" }),
      fixtureRecord({ instance_id: "repo__repo-3" }),
    ]);

    const instances = loadVerifiedDataset(path);
    expect(instances).toHaveLength(3);
    expect(instances.map((i) => i.instanceId)).toEqual([
      "repo__repo-1",
      "repo__repo-2",
      "repo__repo-3",
    ]);
  });

  it("skips blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "swe-bench-dataset-"));
    const path = join(dir, "verified.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(fixtureRecord({ instance_id: "repo__repo-1" })),
        "",
        "   ",
        JSON.stringify(fixtureRecord({ instance_id: "repo__repo-2" })),
      ].join("\n"),
    );

    const instances = loadVerifiedDataset(path);
    expect(instances).toHaveLength(2);
  });

  it("throws with the offending line number on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "swe-bench-dataset-"));
    const path = join(dir, "verified.jsonl");
    writeFileSync(
      path,
      [JSON.stringify(fixtureRecord()), "{not valid json", ""].join("\n"),
    );

    expect(() => loadVerifiedDataset(path)).toThrow(/line 2/);
  });

  it("throws on a record missing required fields", () => {
    const record = fixtureRecord();
    delete (record as any).patch;
    const path = writeFixtureJsonl([record]);
    expect(() => loadVerifiedDataset(path)).toThrow(DatasetValidationError);
  });
});

describe("selectDeterministicSubset", () => {
  const instances = Array.from({ length: 20 }, (_, i) => ({
    instanceId: `repo__repo-${i}`,
  }));

  it("returns exactly `limit` instances", () => {
    const subset = selectDeterministicSubset(instances, {
      limit: 5,
      seed: 42,
    });
    expect(subset).toHaveLength(5);
  });

  it("is stable for a fixed seed", () => {
    const first = selectDeterministicSubset(instances, {
      limit: 5,
      seed: 42,
    });
    const second = selectDeterministicSubset(instances, {
      limit: 5,
      seed: 42,
    });
    expect(second).toEqual(first);
  });

  it("is stable for a fixed seed regardless of input order", () => {
    const shuffledInput = [...instances].reverse();
    const a = selectDeterministicSubset(instances, { limit: 5, seed: "abc" });
    const b = selectDeterministicSubset(shuffledInput, {
      limit: 5,
      seed: "abc",
    });
    expect(b).toEqual(a);
  });

  it("produces different subsets for different seeds (in general)", () => {
    const a = selectDeterministicSubset(instances, { limit: 5, seed: 1 });
    const b = selectDeterministicSubset(instances, { limit: 5, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("returns instances sorted by instanceId", () => {
    const subset = selectDeterministicSubset(instances, {
      limit: 5,
      seed: 7,
    });
    const ids = subset.map((i) => i.instanceId);
    expect(ids).toEqual([...ids].sort());
  });

  it("caps at the number of available instances", () => {
    const subset = selectDeterministicSubset(instances, {
      limit: 1000,
      seed: 1,
    });
    expect(subset).toHaveLength(20);
  });

  it("returns an empty array for a non-positive limit", () => {
    expect(selectDeterministicSubset(instances, { limit: 0, seed: 1 })).toEqual(
      [],
    );
  });

  it("returns an empty array for empty input", () => {
    expect(selectDeterministicSubset([], { limit: 5, seed: 1 })).toEqual([]);
  });
});

describe("loadVerifiedSubset", () => {
  it("loads a JSONL file and deterministically samples N instances", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      fixtureRecord({ instance_id: `repo__repo-${i}` }),
    );
    const path = writeFixtureJsonl(records);

    const subsetA = loadVerifiedSubset(path, {
      split: "verified",
      limit: 3,
      seed: 99,
    });
    const subsetB = loadVerifiedSubset(path, {
      split: "verified",
      limit: 3,
      seed: 99,
    });

    expect(subsetA).toHaveLength(3);
    expect(subsetB).toEqual(subsetA);
  });
});
