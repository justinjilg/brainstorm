import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processSpawnTool } from "../builtin/process-manage.js";

const touchedFiles: string[] = [];
let originalAwsSecret: string | undefined;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(() => {
  if (originalAwsSecret === undefined) {
    delete process.env.AWS_SECRET_ACCESS_KEY;
  } else {
    process.env.AWS_SECRET_ACCESS_KEY = originalAwsSecret;
  }
  originalAwsSecret = undefined;

  for (const file of touchedFiles.splice(0)) {
    rmSync(file, { force: true });
  }
});

describe("process_spawn", () => {
  it("does not inherit scrubbed secret environment variables", async () => {
    originalAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-reach-child";

    const target = join(
      tmpdir(),
      `brainstorm-process-env-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    touchedFiles.push(target);

    const result = await processSpawnTool.execute({
      name: `env-scrub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      command: `printf "%s" "$AWS_SECRET_ACCESS_KEY" > ${JSON.stringify(target)}`,
    });

    expect(result).toMatchObject({ success: true });
    await waitForFile(target);
    expect(readFileSync(target, "utf-8")).toBe("");
  });
});
