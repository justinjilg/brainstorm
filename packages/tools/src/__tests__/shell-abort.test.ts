/**
 * Shell tool abort propagation.
 *
 * Regression trap for the class the Vercel AI SDK + Claude Agent SDK
 * both warn about: when the agent loop is cancelled (user Stop, budget
 * exceeded, HTTP disconnect), the AbortSignal is forwarded to
 * `tool.execute` via ToolExecuteContext. If the tool ignores it, user
 * cancel leaves a runaway subprocess.
 *
 * Before the pass-8 fix the shell tool never accepted the ctx argument,
 * so `sleep 30` would keep running to completion after cancel. This
 * test is the contract: abort mid-execution, child dies within a few
 * seconds, exitCode signals termination.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellTool } from "../builtin/shell";

describe("shell tool — abort propagation", () => {
  it("terminates the child process when the AbortSignal fires", async () => {
    // Prove the abort path works end-to-end against a real subprocess.
    // Pick a long sleep so the child cannot finish naturally before
    // the abort fires, and pick a marker-tagged command so the
    // assertion can't be polluted by other `sleep` processes on the
    // machine.
    const marker = `bst-abort-probe-${Date.now().toString(36)}`;
    const controller = new AbortController();

    // Fire the abort slightly after the tool starts so the child has
    // actually been spawned when the signal arrives — otherwise we'd
    // only be testing the "already-aborted" fast path.
    setTimeout(() => controller.abort(), 200);

    const start = Date.now();
    const result = await shellTool.execute(
      {
        command: `# ${marker}\nsleep 30`,
        cwd: undefined,
        timeout: 60_000,
        background: false,
      },
      { abortSignal: controller.signal },
    );
    const elapsed = Date.now() - start;

    // If abort DIDN'T propagate, elapsed would be ~30s (the sleep)
    // or 60s (the timeout). It should be well under 5s for a proper
    // SIGTERM + grace period.
    expect(
      elapsed,
      `shell tool took ${elapsed}ms to return after abort — signal did not propagate to child`,
    ).toBeLessThan(8_000);

    // Child died via signal, not natural exit. The shell tool bubbles
    // up the POSIX signal name on terminated children.
    expect("signal" in result ? result.signal : undefined).toBeTruthy();

    // Belt-and-braces: confirm no stray child with our marker survived
    // the abort. pgrep returns 1 on no match; we accept that as the
    // happy path.
    await new Promise((r) => setTimeout(r, 500));
    const survivors = await new Promise<string[]>((resolve) => {
      const p = spawn("pgrep", ["-f", marker], { stdio: "pipe" });
      let out = "";
      p.stdout.on("data", (c) => (out += c.toString()));
      p.on("close", () => resolve(out.split("\n").filter(Boolean)));
    });
    expect(
      survivors,
      `sleep process with marker ${marker} survived abort: pids=${survivors.join(",")}`,
    ).toHaveLength(0);
  }, 30_000);

  it("is a no-op when no AbortSignal is provided", async () => {
    // Guard against a regression where touching ctx?.abortSignal throws
    // for callers that don't pass ctx at all (all legacy call sites).
    const result = await shellTool.execute({
      command: "echo hello",
      cwd: undefined,
      timeout: 10_000,
      background: false,
    });
    expect(result).toMatchObject({
      stdout: expect.stringContaining("hello"),
      exitCode: 0,
    });
  }, 15_000);

  it("terminates immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await shellTool.execute(
      {
        command: "sleep 30",
        cwd: undefined,
        timeout: 60_000,
        background: false,
      },
      { abortSignal: controller.signal },
    );
    const elapsed = Date.now() - start;

    // Pre-aborted path skips the sleep entirely; a few hundred ms is
    // spawn overhead + SIGKILL grace period.
    expect(elapsed).toBeLessThan(4_000);
  }, 10_000);
});
