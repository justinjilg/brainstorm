/**
 * Go struct generator — STUB.
 *
 * Same role as the pydantic generator, for the BrainstormVM product
 * server (Go). Emits a `platform_contract.go` package with idiomatic
 * `type FooRequest struct { ... }` declarations and `json:"field"`
 * tags. Real emission is deferred to Stage-2b alongside the pydantic
 * work; the stub keeps the compiler's dispatch table complete.
 */

import type { EndpointDef } from "../schemas.js";

export interface GoFile {
  path: string;
  content: string;
}

export function generateGo(endpoints: EndpointDef[]): GoFile[] {
  const lines: string[] = [];
  lines.push("// Brainstorm Platform Contract v1 — Go structs.");
  lines.push("//");
  lines.push("// STUB. Real emission is tracked under Stage-2b.");
  lines.push("//");
  lines.push("// Endpoints currently in the contract:");
  for (const ep of endpoints) {
    lines.push(`//   - ${ep.method} ${ep.path}  (${ep.id})`);
  }
  lines.push("");
  lines.push("package platformcontract");
  lines.push("");
  lines.push("// TODO(stage-2b): emit struct declarations here.");
  lines.push("");

  return [
    {
      path: "platform_contract.go",
      content: lines.join("\n"),
    },
  ];
}
