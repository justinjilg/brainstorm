import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
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
      return [
        path,
        stat.isSymbolicLink()
          ? `symlink:${realpathSync(absolute)}`
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

export const localCommandExecutor: E2ECommandExecutor = {
  run(argv, cwd, timeoutMs) {
    return new Promise((resolveResult) => {
      const startedAt = Date.now();
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          TMPDIR: process.env.TMPDIR,
          CI: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
  },
};

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
    const after = snapshotSandbox(sandboxRoot);
    add(
      "workspace:no-mutation",
      before !== undefined && JSON.stringify(before) === JSON.stringify(after),
      before === undefined
        ? "beforeSnapshot is required for noMutation tasks"
        : JSON.stringify(before) === JSON.stringify(after)
          ? "workspace unchanged"
          : "workspace changed",
    );
  }

  return {
    passed: checks.length > 0 && checks.every((check) => check.passed),
    checks,
    artifacts: evidence(sandboxRoot, artifactPaths),
    durationMs: Date.now() - startedAt,
  };
}
