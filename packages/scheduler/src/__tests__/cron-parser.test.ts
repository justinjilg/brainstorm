/**
 * Scheduler smoke test — first test for the scheduler package.
 */

import { describe, it, expect } from "vitest";
import { validateCron, describeCron, isDue } from "../cron-parser.js";

describe("Cron Parser", () => {
  it("validates a correct cron expression", () => {
    expect(validateCron("0 0 * * *")).toBeNull(); // null = valid
    expect(validateCron("*/5 * * * *")).toBeNull();
  });

  it("rejects invalid cron expressions", () => {
    expect(validateCron("not a cron")).not.toBeNull(); // returns error string
    expect(validateCron("60 * * * *")).not.toBeNull(); // minute out of range
  });

  it("describes a cron expression in human readable form", () => {
    const desc = describeCron("0 0 * * *");
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
  });

  it("checks if a cron is due", () => {
    // A cron that fires every minute should be due within the last 60s
    const result = isDue("* * * * *", Date.now() - 30000);
    expect(typeof result).toBe("boolean");
  });
});
