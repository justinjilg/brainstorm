import { runEvalCli } from "@brainst0rm/eval";

// Probes introspect the brainstorm repo — cwd must be the repo root.
process.chdir("/Users/justin.jilg/Projects/brainstorm");

const models = [
  "acronis:h200/gpt-oss-120b",
  "acronis:h200/Qwen/Qwen3-Next-80B-A3B-Instruct-FP8",
  "acronis:mac/qwen/qwen3-coder-next",
];
for (const model of models) {
  console.log(`\n===== evaluating ${model} =====`);
  await runEvalCli({ model, timeout: 180000 });
}
console.log("\n===== comparison =====");
await runEvalCli({ compare: true });
