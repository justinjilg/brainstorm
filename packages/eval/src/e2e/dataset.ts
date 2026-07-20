import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  E2EDomain,
  E2ETask,
  E2EVerificationContract,
  FileAssertion,
  VerificationKind,
} from "./types.js";

const DOMAINS = new Set<E2EDomain>([
  "coding",
  "web",
  "documentation",
  "infrastructure",
  "adversarial",
]);

const VERIFICATION_KINDS = new Set<VerificationKind>([
  "command",
  "static-web",
  "document",
  "structured-data",
  "policy",
]);

export class E2EDatasetError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "E2EDatasetError";
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new E2EDatasetError(`${field} must be a non-empty string`);
  }
  return value;
}

function safeRelativePath(value: unknown, field: string): string {
  const path = nonEmptyString(value, field);
  if (
    isAbsolute(path) ||
    path.split(/[\\/]+/).some((segment) => segment === "..")
  ) {
    throw new E2EDatasetError(`${field} must stay inside the sandbox`);
  }
  return path;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new E2EDatasetError(`${field} must be an array of strings`);
  }
  return value;
}

function fileAssertions(value: unknown): FileAssertion[] {
  if (!Array.isArray(value)) {
    throw new E2EDatasetError("verify.fileAssertions must be an array");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new E2EDatasetError(
        `verify.fileAssertions[${index}] must be an object`,
      );
    }
    const raw = item as Record<string, unknown>;
    return {
      path: safeRelativePath(raw.path, `verify.fileAssertions[${index}].path`),
      contains:
        raw.contains === undefined
          ? undefined
          : stringArray(
              raw.contains,
              `verify.fileAssertions[${index}].contains`,
            ),
      excludes:
        raw.excludes === undefined
          ? undefined
          : stringArray(
              raw.excludes,
              `verify.fileAssertions[${index}].excludes`,
            ),
    };
  });
}

function verification(value: unknown): E2EVerificationContract {
  if (!value || typeof value !== "object") {
    throw new E2EDatasetError("verify must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (!VERIFICATION_KINDS.has(raw.kind as VerificationKind)) {
    throw new E2EDatasetError(`unknown verification kind: ${String(raw.kind)}`);
  }
  const requiredFiles = raw.requiredFiles
    ? stringArray(raw.requiredFiles, "verify.requiredFiles").map((path) =>
        safeRelativePath(path, "verify.requiredFiles[]"),
      )
    : undefined;
  const commands = raw.commands
    ? stringArray(raw.commands, "verify.commands")
    : undefined;
  if (commands?.some((command) => command.trim().length === 0)) {
    throw new E2EDatasetError("verify.commands cannot contain empty commands");
  }
  if (
    raw.rubric !== undefined &&
    raw.rubric !== "web-quality-v1" &&
    raw.rubric !== "documentation-quality-v1"
  ) {
    throw new E2EDatasetError(`unknown rubric: ${String(raw.rubric)}`);
  }
  if (raw.noMutation !== undefined && typeof raw.noMutation !== "boolean") {
    throw new E2EDatasetError("verify.noMutation must be a boolean");
  }
  return {
    kind: raw.kind as VerificationKind,
    requiredFiles,
    commands,
    fileAssertions:
      raw.fileAssertions === undefined
        ? undefined
        : fileAssertions(raw.fileAssertions),
    rubric:
      raw.rubric === "web-quality-v1" ||
      raw.rubric === "documentation-quality-v1"
        ? raw.rubric
        : undefined,
    noMutation: raw.noMutation,
  };
}

export function validateE2ETask(value: unknown): E2ETask {
  if (!value || typeof value !== "object") {
    throw new E2EDatasetError("task must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new E2EDatasetError("version must be 1");
  if (!DOMAINS.has(raw.domain as E2EDomain)) {
    throw new E2EDatasetError(`unknown domain: ${String(raw.domain)}`);
  }
  if (raw.workspace !== "sandbox") {
    throw new E2EDatasetError("workspace must be sandbox");
  }
  if (!Number.isInteger(raw.maxSteps) || Number(raw.maxSteps) < 1) {
    throw new E2EDatasetError("maxSteps must be a positive integer");
  }
  if (!Number.isInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 1_000) {
    throw new E2EDatasetError("timeoutMs must be an integer >= 1000");
  }
  const tags = stringArray(raw.tags, "tags");
  if (tags.length === 0) throw new E2EDatasetError("tags cannot be empty");

  let setup: E2ETask["setup"];
  if (raw.setup !== undefined) {
    if (!raw.setup || typeof raw.setup !== "object") {
      throw new E2EDatasetError("setup must be an object");
    }
    const files = (raw.setup as Record<string, unknown>).files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      throw new E2EDatasetError("setup.files must be an object");
    }
    const validated: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      validated[safeRelativePath(path, "setup.files path")] = nonEmptyString(
        content,
        `setup.files[${path}]`,
      );
    }
    setup = { files: validated };
  }

  return {
    id: nonEmptyString(raw.id, "id"),
    version: 1,
    domain: raw.domain as E2EDomain,
    title: nonEmptyString(raw.title, "title"),
    prompt: nonEmptyString(raw.prompt, "prompt"),
    workspace: "sandbox",
    setup,
    verify: verification(raw.verify),
    maxSteps: Number(raw.maxSteps),
    timeoutMs: Number(raw.timeoutMs),
    tags,
  };
}

export function loadE2EDataset(path: string): E2ETask[] {
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const tasks: E2ETask[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const task = validateE2ETask(JSON.parse(line));
      if (ids.has(task.id)) {
        throw new E2EDatasetError(`duplicate task id: ${task.id}`);
      }
      ids.add(task.id);
      tasks.push(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new E2EDatasetError(message, index + 1);
    }
  }
  return tasks;
}
