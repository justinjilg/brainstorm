#!/usr/bin/env tsx
/**
 * Contract compiler entrypoint.
 *
 * Walks `packages/godmode/src/contract/schemas.ts`, dispatches each
 * registered generator, and either prints the result or writes the
 * generated files to disk. Equivalent to BR's `scripts/contract-compile.ts`
 * for the brainstorm platform contract.
 *
 * Usage:
 *   pnpm -w --filter @brainst0rm/godmode run compile-contract           # print summary
 *   pnpm -w --filter @brainst0rm/godmode run compile-contract -- --write
 *   pnpm -w --filter @brainst0rm/godmode run compile-contract -- --emit=json-schema
 *   pnpm -w --filter @brainst0rm/godmode run compile-contract -- --emit=markdown
 *
 * Exit codes:
 *   0 — compiled OK
 *   1 — generator threw or output failed shape check
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContract } from "../src/contract/compile.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const GENERATED_ROOT = resolve(REPO_ROOT, "generated/platform-contract");

function main(): void {
  const args = new Set(process.argv.slice(2));
  const writeMode = args.has("--write");
  const emitArg = process.argv.find((a) => a.startsWith("--emit="));
  const emit = emitArg ? emitArg.slice("--emit=".length) : "all";

  const output = compileContract();

  process.stdout.write(`\n=== Brainstorm Platform Contract Compiler ===\n\n`);
  process.stdout.write(`  Endpoints: ${output.endpoints.length}\n`);
  for (const ep of output.endpoints) {
    process.stdout.write(
      `    • ${ep.method.padEnd(4)} ${ep.path.padEnd(40)} (${ep.id})\n`,
    );
  }
  process.stdout.write("\n");

  const emitJsonSchema = emit === "all" || emit === "json-schema";
  const emitMarkdown = emit === "all" || emit === "markdown";
  const emitPydantic = emit === "all" || emit === "pydantic";
  const emitGo = emit === "all" || emit === "go";

  if (writeMode) {
    if (emitJsonSchema) {
      writeFile(
        resolve(GENERATED_ROOT, "platform-contract.schema.json"),
        JSON.stringify(output.jsonSchema, null, 2) + "\n",
      );
    }
    if (emitMarkdown) {
      for (const section of output.markdown) {
        writeFile(
          resolve(GENERATED_ROOT, `markdown/${section.id}.md`),
          section.markdown,
        );
      }
    }
    if (emitPydantic) {
      for (const file of output.pydantic) {
        writeFile(resolve(GENERATED_ROOT, "python", file.path), file.content);
      }
    }
    if (emitGo) {
      for (const file of output.go) {
        writeFile(resolve(GENERATED_ROOT, "go", file.path), file.content);
      }
    }
    process.stdout.write(`✔ Wrote artifacts under ${GENERATED_ROOT}\n`);
  } else {
    process.stdout.write(`(dry run — pass --write to persist artifacts)\n`);
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const rel = path.replace(REPO_ROOT + "/", "");
  process.stdout.write(`  wrote ${rel}\n`);
}

main();
