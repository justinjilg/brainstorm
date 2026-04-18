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
import { describe, expect, it, afterEach } from "vitest";
import { shellTool, setBackgroundEventHandler } from "../builtin/shell";

describe("shell tool — abort propagation", () => {
  afterEach(() => {
    // Clear the module-level handler so background-event tests don't
    // contaminate each other.
    setBackgroundEventHandler(null);
  });

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
    // up the POSIX signal name on terminated children. `result` is
    // typed as `unknown` because defineTool's execute() has a generic
    // TOutput — we asserted its shape with a narrow helper so the
    // test stays strict even if the signature ever gets stricter.
    const outcome = result as { signal?: string; exitCode?: number };
    expect(outcome.signal).toBeTruthy();

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

  it("kills the background child when AbortSignal fires mid-flight (S2)", async () => {
    // Regression trap for the S2 review finding: the `background: true`
    // branch used to drop `ctx.abortSignal` on the floor. A user Stop
    // during a turn that spawned a background dev server would leave
    // the server running forever; the completion event never fired,
    // so the agent never saw closure either.
    //
    // This test waits for the background completion event rather than
    // the execute() return value (which lands immediately with a
    // taskId) — that's the only signal the rest of the system gets
    // that a background task ended, and the bug shape was that this
    // event never arrived when the turn was cancelled.
    const marker = `bst-bg-abort-${Date.now().toString(36)}`;
    const controller = new AbortController();

    const completion = new Promise<{ exitCode: number; taskId: string }>(
      (resolve) => {
        setBackgroundEventHandler((event) => {
          if (event.command.includes(marker)) {
            resolve({ exitCode: event.exitCode, taskId: event.taskId });
          }
        });
      },
    );

    const result = await shellTool.execute(
      {
        command: `# ${marker}\nsleep 30`,
        cwd: undefined,
        timeout: 60_000,
        background: true,
      },
      { abortSignal: controller.signal },
    );
    expect(result).toMatchObject({ status: "running" });

    // Fire the abort after the child has definitely spawned.
    setTimeout(() => controller.abort(), 200);

    const start = Date.now();
    const { exitCode } = await completion;
    const elapsed = Date.now() - start;

    // If abort didn't propagate, completion wouldn't arrive for 30s
    // (sleep) or 60s (timeout). Should be well under 5s through the
    // SIGTERM grace period.
    expect(
      elapsed,
      `background completion took ${elapsed}ms after abort — signal did not propagate to child`,
    ).toBeLessThan(8_000);

    // Signal-terminated child reports non-zero exit (128 for signal).
    expect(exitCode).not.toBe(0);

    // Final proof: no leftover sleep with our marker.
    await new Promise((r) => setTimeout(r, 500));
    const survivors = await new Promise<string[]>((resolve) => {
      const p = spawn("pgrep", ["-f", marker], { stdio: "pipe" });
      let out = "";
      p.stdout.on("data", (c) => (out += c.toString()));
      p.on("close", () => resolve(out.split("\n").filter(Boolean)));
    });
    expect(
      survivors,
      `background sleep with marker ${marker} survived abort: pids=${survivors.join(",")}`,
    ).toHaveLength(0);
  }, 30_000);

  it("kills the background child immediately when signal is pre-aborted", async () => {
    // Catch the branch where abort fires before the background
    // listener registers — same race class as the foreground
    // pre-aborted case, but for the bg path that returns early.
    const marker = `bst-bg-pre-${Date.now().toString(36)}`;
    const controller = new AbortController();
    controller.abort();

    const completion = new Promise<number>((resolve) => {
      setBackgroundEventHandler((event) => {
        if (event.command.includes(marker)) resolve(event.exitCode);
      });
    });

    const start = Date.now();
    await shellTool.execute(
      {
        command: `# ${marker}\nsleep 30`,
        cwd: undefined,
        timeout: 60_000,
        background: true,
      },
      { abortSignal: controller.signal },
    );

    const exitCode = await completion;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);
    expect(exitCode).not.toBe(0);
  }, 10_000);
});
