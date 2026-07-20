import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  E2EArtifactEvidence,
  E2ETask,
  E2EVerificationCheck,
  E2EVerificationResult,
} from "./types.js";

const MAX_COMMAND_OUTPUT = 200_000;
const V1_EXECUTABLES = new Set(["node"]);

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface E2ECommandExecutor {
  run(argv: string[], cwd: string, timeoutMs: number): Promise<CommandResult>;
}

export type SandboxSnapshot = Record<string, string>;

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function sandboxPath(root: string, path: string): string {
  if (path.includes("\0")) {
    throw new Error(`path contains a null byte: ${JSON.stringify(path)}`);
  }
  if (
    isAbsolute(path) ||
    path.split(/[\\/]+/).some((segment) => segment === "..")
  ) {
    throw new Error(`path escapes sandbox: ${path}`);
  }
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, path);
  if (!inside(canonicalRoot, candidate)) {
    throw new Error(`path escapes sandbox: ${path}`);
  }
  if (existsSync(candidate)) {
    const canonicalCandidate = realpathSync(candidate);
    if (!inside(canonicalRoot, canonicalCandidate)) {
      throw new Error(`symlink escapes sandbox: ${path}`);
    }
    // Return the CANONICAL path so callers open exactly what containment was
    // proven against — closes the check-here / open-a-different-path TOCTOU
    // where the final component is a symlink resolved differently at read time.
    return canonicalCandidate;
  }
  return candidate;
}

function walkFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      // Include the link in the snapshot without following it.
      files.push(absolute);
    } else if (entry.isDirectory()) {
      files.push(...walkFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

export function snapshotSandbox(root: string): SandboxSnapshot {
  const canonicalRoot = realpathSync(root);
  return Object.fromEntries(
    walkFiles(canonicalRoot).map((absolute) => {
      const path = relative(canonicalRoot, absolute);
      const stat = lstatSync(absolute);
      // Record the RAW link target (readlinkSync), never realpathSync: a
      // model can plant a symlink to a nonexistent target, and realpathSync
      // throws ENOENT on it — which previously crashed the whole snapshot (and
      // thus the noMutation check) instead of recording a stable value. The raw
      // target string still changes if the link is added/retargeted/removed, so
      // mutation is still detected, and we never follow the link off-sandbox.
      return [
        path,
        stat.isSymbolicLink()
          ? `symlink:${readlinkSync(absolute)}`
          : hash(readFileSync(absolute)),
      ];
    }),
  );
}

function parseCommand(command: string): string[] {
  const argv: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) {
    argv.push((match[1] ?? match[2] ?? match[3]).replace(/\\"/g, '"'));
  }
  if (argv.length === 0) throw new Error("verification command is empty");
  if (!V1_EXECUTABLES.has(argv[0])) {
    throw new Error(`verification executable is not allowed in v1: ${argv[0]}`);
  }
  return argv;
}

/**
 * Spawn a command, collect capped output, and enforce a timeout by killing the
 * whole PROCESS GROUP — not just the direct child. `node --test` (and any
 * command the sandbox runs) can fork grandchildren; killing only the child PID
 * leaves survivors running in the sandbox that tamper with files AFTER
 * verification checks pass. `detached: true` puts the child in its own group;
 * `process.kill(-pid, …)` signals the entire group. The group is also reaped on
 * normal settle so no survivor outlives the run. (A grandchild that itself
 * re-detaches via setsid escapes process groups entirely — only a PID namespace
 * contains that, which is what the Docker executor provides.)
 */
function spawnCollect(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const child = spawn(file, args, {
      cwd: opts.cwd,
      shell: false,
      detached: true,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the whole group created by detached: true.
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone / never created — fall back to the direct child.
        try {
          child.kill(signal);
        } catch {
          /* already reaped */
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, opts.timeoutMs);
    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reap any grandchildren the command detached before we resolve.
      killGroup("SIGKILL");
      if (spawnError) stderr += spawnError.message;
      resolveResult({
        exitCode,
        stdout: stdout.slice(0, MAX_COMMAND_OUTPUT),
        stderr: stderr.slice(0, MAX_COMMAND_OUTPUT),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

export const localCommandExecutor: E2ECommandExecutor = {
  run(argv, cwd, timeoutMs) {
    // NOTE: this executor isolates the process GROUP and scrubs secrets from the
    // child env, but the sandbox is a working directory, NOT a filesystem jail —
    // `node --test` runs model-authored code that can still READ host files. For
    // untrusted / adversarial runs, inject `dockerCommandExecutor` (below) via
    // the `executor` option so commands run in a read-only-host, network-none
    // container.
    return spawnCollect(argv[0], argv.slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        TMPDIR: process.env.TMPDIR,
        CI: "1",
      },
      timeoutMs,
    });
  },
};

export interface DockerExecutorConfig {
  /** Container image with the allowed interpreter(s). */
  image: string;
  /** Memory cap (docker --memory). */
  memory: string;
  /** Pids cap (docker --pids-limit). */
  pidsLimit: number;
}

export const DEFAULT_DOCKER_EXECUTOR_CONFIG: DockerExecutorConfig = {
  image: "node:22-slim",
  memory: "512m",
  pidsLimit: 256,
};

/**
 * Build the `docker run` argv that jails a verification command: the sandbox is
 * mounted read-WRITE at /work (editing the workspace IS the task), but nothing
 * else of the host is visible; the root FS is read-only, networking is off, the
 * process drops to an unprivileged uid, and memory/pids are capped. Pure so the
 * argv can be unit-tested without a Docker daemon.
 */
export function buildDockerRunArgs(
  argv: string[],
  hostCwd: string,
  config: DockerExecutorConfig = DEFAULT_DOCKER_EXECUTOR_CONFIG,
): string[] {
  return [
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    `--memory=${config.memory}`,
    `--pids-limit=${config.pidsLimit}`,
    // Writable workspace + a small writable tmp (read-only root blocks /tmp).
    "-v",
    `${hostCwd}:/work:rw`,
    "--tmpfs",
    "/tmp:rw,size=64m",
    "-w",
    "/work",
    "--env",
    "CI=1",
    "--env",
    "HOME=/work",
    config.image,
    ...argv,
  ];
}

/**
 * Container-jailed executor. Runs the (allowlisted) command inside a throwaway
 * `docker run` with no network and a read-only host FS, reusing the same
 * process-group + timeout machinery to bound the `docker` client itself. Inject
 * this via `verifyE2EArtifact(..., { executor })` for untrusted runs. Requires a
 * working Docker daemon.
 */
export function createDockerCommandExecutor(
  config: DockerExecutorConfig = DEFAULT_DOCKER_EXECUTOR_CONFIG,
): E2ECommandExecutor {
  return {
    run(argv, cwd, timeoutMs) {
      return spawnCollect("docker", buildDockerRunArgs(argv, cwd, config), {
        cwd,
        env: { PATH: process.env.PATH },
        timeoutMs,
      });
    },
  };
}

function evidence(root: string, paths: string[]): E2EArtifactEvidence[] {
  return [...new Set(paths)].flatMap((path) => {
    try {
      const absolute = sandboxPath(root, path);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) return [];
      const content = readFileSync(absolute);
      return [{ path, sha256: hash(content), bytes: content.byteLength }];
    } catch {
      return [];
    }
  });
}

export async function verifyE2EArtifact(
  task: E2ETask,
  sandboxRoot: string,
  options: {
    executor?: E2ECommandExecutor;
    beforeSnapshot?: SandboxSnapshot;
  } = {},
): Promise<E2EVerificationResult> {
  const startedAt = Date.now();
  const checks: E2EVerificationCheck[] = [];
  const artifactPaths = [
    ...(task.verify.requiredFiles ?? []),
    ...(task.verify.fileAssertions ?? []).map((item) => item.path),
  ];
  const add = (
    id: string,
    passed: boolean,
    detail: string,
    durationMs?: number,
  ) => checks.push({ id, passed, detail, durationMs });

  for (const path of task.verify.requiredFiles ?? []) {
    try {
      const absolute = sandboxPath(sandboxRoot, path);
      const present = existsSync(absolute) && statSync(absolute).isFile();
      add(
        `file:${path}`,
        present,
        present ? "present" : "missing required file",
      );
    } catch (error) {
      add(`file:${path}`, false, (error as Error).message);
    }
  }

  for (const assertion of task.verify.fileAssertions ?? []) {
    try {
      const content = readFileSync(
        sandboxPath(sandboxRoot, assertion.path),
        "utf8",
      );
      for (const expected of assertion.contains ?? []) {
        add(
          `contains:${assertion.path}:${expected}`,
          content.includes(expected),
          content.includes(expected)
            ? "found"
            : `missing ${JSON.stringify(expected)}`,
        );
      }
      for (const forbidden of assertion.excludes ?? []) {
        add(
          `excludes:${assertion.path}:${forbidden}`,
          !content.includes(forbidden),
          !content.includes(forbidden)
            ? "absent"
            : `found forbidden ${JSON.stringify(forbidden)}`,
        );
      }
    } catch (error) {
      add(`read:${assertion.path}`, false, (error as Error).message);
    }
  }

  // Setup fixtures are immutable unless the task explicitly declares them as
  // produced/edited artifacts through requiredFiles. This protects tests,
  // policies, and adversarial input from being rewritten to make checks pass.
  const mutable = new Set(task.verify.requiredFiles ?? []);
  for (const [path, original] of Object.entries(task.setup?.files ?? {})) {
    if (mutable.has(path)) continue;
    try {
      const actual = readFileSync(sandboxPath(sandboxRoot, path), "utf8");
      add(
        `fixture:${path}`,
        actual === original,
        actual === original ? "unchanged" : "setup fixture was modified",
      );
    } catch (error) {
      add(`fixture:${path}`, false, (error as Error).message);
    }
  }

  if (task.verify.kind === "structured-data" || task.verify.kind === "policy") {
    for (const path of task.verify.requiredFiles ?? []) {
      if (!path.endsWith(".json")) continue;
      try {
        JSON.parse(readFileSync(sandboxPath(sandboxRoot, path), "utf8"));
        add(`json:${path}`, true, "valid JSON");
      } catch (error) {
        add(`json:${path}`, false, `invalid JSON: ${(error as Error).message}`);
      }
    }
  }

  if (task.verify.kind === "static-web") {
    const htmlPath = (task.verify.requiredFiles ?? []).find((path) =>
      path.endsWith(".html"),
    );
    if (htmlPath) {
      try {
        const html = readFileSync(sandboxPath(sandboxRoot, htmlPath), "utf8");
        add(
          "web:document",
          /<!doctype html>|<html[\s>]/i.test(html),
          "HTML document",
        );
        add(
          "web:viewport",
          /name=["']viewport["']/i.test(html),
          "responsive viewport metadata",
        );
      } catch (error) {
        add("web:document", false, (error as Error).message);
      }
    }
  }

  for (const command of task.verify.commands ?? []) {
    try {
      const argv = parseCommand(command);
      const result = await (options.executor ?? localCommandExecutor).run(
        argv,
        realpathSync(sandboxRoot),
        task.timeoutMs,
      );
      const passed = result.exitCode === 0 && !result.timedOut;
      add(
        `command:${command}`,
        passed,
        passed
          ? "exit 0"
          : result.timedOut
            ? `timed out after ${task.timeoutMs}ms`
            : `exit ${String(result.exitCode)}: ${(result.stderr || result.stdout).slice(0, 500)}`,
        result.durationMs,
      );
    } catch (error) {
      add(`command:${command}`, false, (error as Error).message);
    }
  }

  if (task.verify.noMutation) {
    const before = options.beforeSnapshot;
    try {
      const after = snapshotSandbox(sandboxRoot);
      add(
        "workspace:no-mutation",
        before !== undefined &&
          JSON.stringify(before) === JSON.stringify(after),
        before === undefined
          ? "beforeSnapshot is required for noMutation tasks"
          : JSON.stringify(before) === JSON.stringify(after)
            ? "workspace unchanged"
            : "workspace changed",
      );
    } catch (error) {
      // Snapshotting must FAIL CLOSED — a model that plants e.g. a symlink the
      // walker can't stat shouldn't crash verification into an ambiguous state.
      add("workspace:no-mutation", false, (error as Error).message);
    }
  }

  return {
    passed: checks.length > 0 && checks.every((check) => check.passed),
    checks,
    artifacts: evidence(sandboxRoot, artifactPaths),
    durationMs: Date.now() - startedAt,
  };
}
