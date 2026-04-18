/**
 * Docker sandbox — daemon / container death recovery trap.
 *
 * Chaos Monkey's 3-round ask (v9/v11/v12): the WAL-recovery trap
 * covered SQLite corruption; the ENOSPC trap covered disk-full.
 * The third corruption surface Chaos kept flagging was Docker
 * dying mid-session. Real scenarios:
 *   - Docker Desktop on macOS crashes while the agent is sandboxed
 *   - Someone runs `docker system prune` while a sandbox container
 *     is running
 *   - The daemon restarts for an upgrade
 *   - Container OOM-killed because the host ran out of memory
 *
 * In every case, our `DockerSandbox.exec()` call happens next and
 * hits a docker CLI that can't reach the daemon or can't find the
 * container. Pre-pass-24 there was no assertion that the failure
 * path even returned cleanly — a rethrown execFileSync would have
 * killed the whole turn with no context for the user.
 *
 * What the trap verifies:
 *   1. `exec()` after external container removal returns non-zero
 *      without throwing (the catch branch in docker-sandbox.ts:171
 *      is load-bearing).
 *   2. The output names the failure (so the user sees "No such
 *      container" or equivalent, not silent exit=1).
 *   3. `start()` against a bogus DOCKER_HOST raises a clear error
 *      that mentions the daemon — not a silent fallback to the
 *      host shell, which would run the command unsandboxed.
 *
 * Env dependency: Docker has to be available. CI runners
 * (ubuntu-latest) ship with Docker; local dev may not. The suite
 * is `describe.skipIf(!dockerAvailable)` so absence is a skip, not
 * a failure — the trap is still meaningful every time Docker IS
 * present, which includes CI.
 *
 * Uses `busybox:latest` (~5MB) for fast pull on first-run CI
 * instead of the production default `node:22-slim` (200MB+). The
 * image choice is irrelevant to what we're testing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandbox } from "../sandbox/docker-sandbox.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const docker = dockerAvailable();
const sandboxes: DockerSandbox[] = [];

afterEach(() => {
  // Best-effort cleanup — tests may leave a container running if they
  // hit an unexpected path. stop() swallows errors (already dead, etc).
  while (sandboxes.length > 0) {
    sandboxes.pop()!.stop();
  }
});

describe.skipIf(!docker)("Docker sandbox — daemon/container death", () => {
  it("exec() returns non-zero without throwing when container is removed out-of-band", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brainstorm-docker-death-"));
    const sandbox = new DockerSandbox({
      hostWorkspace: workspace,
      image: "busybox:latest",
      timeout: 10_000,
    });
    sandboxes.push(sandbox);

    sandbox.start();
    const cid = sandbox.getContainerId();
    expect(cid, "start() did not produce a containerId").toBeTruthy();

    // Sanity-check: exec works normally BEFORE the out-of-band kill.
    const before = sandbox.exec("echo hello");
    expect(before.exitCode, "baseline exec failed — harness broken").toBe(0);

    // Simulate the Chaos scenario: someone/something kills the
    // container while the sandbox still thinks it's alive. `docker
    // rm -f` is the exact shape of `docker system prune --volumes`
    // or a daemon-restart reap.
    execFileSync("docker", ["rm", "-f", cid!], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    });

    // Post-kill exec must NOT throw (the catch branch in
    // docker-sandbox.ts is the production contract) and must
    // return a non-zero exit with informative output.
    let result: ReturnType<DockerSandbox["exec"]> | null = null;
    expect(() => {
      result = sandbox.exec("echo hello");
    }, "exec() threw after container removal — catch branch broken").not.toThrow();

    expect(result!.exitCode, "post-death exec returned success").not.toBe(0);
    expect(
      result!.output,
      "post-death exec produced empty output — user has no error context",
    ).toMatch(/no such container|cannot connect|error/i);
  }, 60_000);

  it("start() throws a clear error when DOCKER_HOST is unreachable", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brainstorm-docker-nohost-"));
    const origHost = process.env.DOCKER_HOST;
    // Point the docker CLI at a socket that does not exist. The
    // critical behavior we're checking: start() must RAISE, not
    // silently return having set containerId to something invalid.
    // A silent failure could leave shell.ts routing commands to a
    // broken sandbox, which then falls through to the unsandboxed
    // shell path — exactly the escape hatch container mode is
    // meant to close.
    process.env.DOCKER_HOST = "unix:///tmp/no-such-socket-for-brainstorm.sock";
    try {
      const sandbox = new DockerSandbox({
        hostWorkspace: workspace,
        image: "busybox:latest",
        timeout: 5_000,
      });
      // Don't push to sandboxes[] — if start() succeeded we'd want
      // to know, not auto-cleanup.

      expect(
        () => sandbox.start(),
        "start() silently succeeded with unreachable daemon — container escape hatch",
      ).toThrow(/(?:Failed to start|Cannot connect|daemon)/i);

      // And the containerId must remain null so subsequent exec()
      // calls hit the "Sandbox not started" guard rather than
      // attempting docker CLI calls against a broken state.
      expect(
        sandbox.getContainerId(),
        "containerId set despite start() failure",
      ).toBeNull();
    } finally {
      if (origHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = origHost;
    }
  }, 30_000);
});
