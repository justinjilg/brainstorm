import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CustomerAccountDriftDetector } from "../customer-account-detector.js";

const NOW_MS = 1_700_000_000_000;

let root: string;

function writeAccount(slug: string, content: string) {
  const dir = join(root, "customers", "accounts", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "account.toml"), content);
}

function writeRuntime(slug: string, content: string) {
  const dir = join(root, "customers", "accounts", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runtime.toml"), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cust-drift-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("CustomerAccountDriftDetector", () => {
  test("emits no drifts when account has no runtime observation", async () => {
    writeAccount("acme", `mrr_intent = 5000\nstatus = "active"\n`);
    const detector = new CustomerAccountDriftDetector(root, {
      now: () => NOW_MS,
    });
    const drifts = await detector.detect();
    expect(drifts).toEqual([]);
  });

  test("emits no drifts when intent matches observed", async () => {
    writeAccount(
      "acme",
      `mrr_intent = 5000\nstatus = "active"\ntier = "premium"\n`,
    );
    writeRuntime(
      "acme",
      `mrr_observed = 5000\nstatus_observed = "active"\ntier_observed = "premium"\n`,
    );
    const detector = new CustomerAccountDriftDetector(root, {
      now: () => NOW_MS,
    });
    const drifts = await detector.detect();
    expect(drifts).toEqual([]);
  });

  test("emits intent-class drift when MRR diverges", async () => {
    writeAccount("acme", `mrr_intent = 5000\nstatus = "active"\n`);
    writeRuntime("acme", `mrr_observed = 7300\nstatus_observed = "active"\n`);
    const detector = new CustomerAccountDriftDetector(root, {
      now: () => NOW_MS,
    });
    const drifts = await detector.detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      field_class: "intent",
      relative_path: "customers/accounts/acme/account.toml",
      field_path: "mrr_intent",
      intent_value: "5000",
      observed_value: "7300",
      severity: "high",
    });
  });

  test("emits multiple drifts across fields and accounts", async () => {
    writeAccount("acme", `mrr_intent = 5000\nstatus = "active"\n`);
    writeRuntime("acme", `mrr_observed = 7300\nstatus_observed = "churned"\n`);

    writeAccount("globex", `tier = "premium"\n`);
    writeRuntime("globex", `tier_observed = "starter"\n`);

    const detector = new CustomerAccountDriftDetector(root, {
      now: () => NOW_MS,
    });
    const drifts = await detector.detect();
    expect(drifts.length).toBe(3);
    const byField = drifts.map((d) => `${d.relative_path}#${d.field_path}`);
    expect(byField).toContain(
      "customers/accounts/acme/account.toml#mrr_intent",
    );
    expect(byField).toContain("customers/accounts/acme/account.toml#status");
    expect(byField).toContain("customers/accounts/globex/account.toml#tier");
  });

  test("status mismatch is critical severity", async () => {
    writeAccount("acme", `status = "active"\n`);
    writeRuntime("acme", `status_observed = "churned"\n`);
    const detector = new CustomerAccountDriftDetector(root);
    const drifts = await detector.detect();
    expect(drifts[0]?.severity).toBe("critical");
  });

  test("unobservedAccounts surfaces accounts with no runtime.toml", async () => {
    writeAccount("acme", `mrr_intent = 5000\n`);
    writeRuntime("acme", `mrr_observed = 5000\n`);

    writeAccount("globex", `mrr_intent = 8000\n`);
    // no runtime for globex

    writeAccount("initech", `mrr_intent = 1200\n`);
    // no runtime for initech

    const detector = new CustomerAccountDriftDetector(root);
    const unobserved = detector.unobservedAccounts();
    expect(unobserved.sort()).toEqual(["globex", "initech"]);
  });

  test("absent customers/accounts dir returns empty", async () => {
    const detector = new CustomerAccountDriftDetector(root);
    const drifts = await detector.detect();
    expect(drifts).toEqual([]);
    expect(detector.unobservedAccounts()).toEqual([]);
  });

  test("malformed account.toml is silently skipped (lenient tier)", async () => {
    writeAccount("acme", `[invalid toml\n`);
    writeAccount("globex", `mrr_intent = 8000\n`);
    writeRuntime("globex", `mrr_observed = 9000\n`);

    const detector = new CustomerAccountDriftDetector(root, {
      now: () => NOW_MS,
    });
    const drifts = await detector.detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.relative_path).toBe(
      "customers/accounts/globex/account.toml",
    );
  });

  test("drift id is stable for same field/account", async () => {
    writeAccount("acme", `mrr_intent = 5000\n`);
    writeRuntime("acme", `mrr_observed = 7000\n`);

    const detector = new CustomerAccountDriftDetector(root, {
      now: () => NOW_MS,
    });
    const a = await detector.detect();
    const b = await detector.detect();
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[0]?.id).toBe("customer-account/acme/mrr_intent");
  });
});
