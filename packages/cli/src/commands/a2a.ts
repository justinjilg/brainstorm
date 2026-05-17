/**
 * `brainstorm a2a invoke <target_did> <capability>` — operator-initiated A2A.
 *
 * Talks to the BrainstormRouter mesh-auth endpoint defined in
 * brainstorm/docs/a2a-protocol-v01.md and implemented in
 * packages/godmode/src/mesh/. Uses the operator's BR API key (from
 * env BRAINSTORM_API_KEY) as the bearer; this MVP path doesn't yet
 * mint a per-agent JWT — the operator is the caller.
 *
 * For long-running invocations the broker returns 202 + status_url and
 * this CLI polls until completion, failure, or expiry.
 *
 * Plan reference: P2/Wk6 #67 of radiant-petting-kitten rev 2.
 * Companion command: `brainstorm trace <traceparent>`.
 */

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { formatTraceparent, newRootTraceparent } from "@brainst0rm/godmode";

interface InvokeOptions {
  input?: string;
  base?: string;
  token?: string;
  pollIntervalMs?: number;
  deadline?: number;
  json?: boolean;
}

const DEFAULT_BR_URL = "https://api.brainstormrouter.com";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_DEADLINE_S = 90;

async function invokeOnce(
  baseUrl: string,
  token: string,
  targetDID: string,
  body: {
    task_id: string;
    capability: string;
    input: unknown;
    deadline_iso?: string;
  },
  traceparent: string,
  idempotencyKey: string,
): Promise<{ status: number; body: any }> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/mesh/invoke/${encodeURIComponent(
    targetDID,
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      traceparent,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Leave as raw text — some non-JSON 5xx pages.
  }
  return { status: res.status, body: parsed };
}

async function pollStatus(
  baseUrl: string,
  token: string,
  statusUrl: string,
): Promise<{ status: number; body: any }> {
  const url = statusUrl.startsWith("http")
    ? statusUrl
    : `${baseUrl.replace(/\/$/, "")}${statusUrl}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { status: res.status, body: parsed };
}

async function runInvoke(
  targetDID: string,
  capability: string,
  opts: InvokeOptions,
): Promise<void> {
  const baseUrl = opts.base ?? process.env.BRAINSTORM_BR_URL ?? DEFAULT_BR_URL;
  const token = opts.token ?? process.env.BRAINSTORM_API_KEY ?? "";
  if (!token) {
    console.error(
      "  Error: BRAINSTORM_API_KEY not set (or pass --token). Required for mesh auth.",
    );
    process.exitCode = 2;
    return;
  }

  let input: unknown = {};
  if (opts.input) {
    if (opts.input === "-") {
      // Read input JSON from stdin.
      const buf: Buffer[] = [];
      for await (const chunk of process.stdin) {
        buf.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(buf).toString("utf8");
      try {
        input = JSON.parse(raw);
      } catch (err) {
        console.error("  Error: --input - expects valid JSON on stdin");
        process.exitCode = 2;
        return;
      }
    } else {
      try {
        input = JSON.parse(opts.input);
      } catch {
        console.error("  Error: --input must be valid JSON");
        process.exitCode = 2;
        return;
      }
    }
  }

  const traceparent = formatTraceparent(newRootTraceparent());
  const taskId = randomUUID();
  const idempotencyKey = randomUUID();
  const deadlineS = opts.deadline ?? DEFAULT_DEADLINE_S;
  if (!Number.isFinite(deadlineS) || deadlineS <= 0) {
    console.error(
      `  Error: --deadline must be a positive number of seconds (got ${opts.deadline})`,
    );
    process.exitCode = 2;
    return;
  }
  const deadlineISO = new Date(Date.now() + deadlineS * 1000).toISOString();

  if (!opts.json) {
    console.log(`  → POST /v1/mesh/invoke/${targetDID}`);
    console.log(`    capability:      ${capability}`);
    console.log(`    task_id:         ${taskId}`);
    console.log(`    traceparent:     ${traceparent}`);
    console.log(`    idempotency_key: ${idempotencyKey}`);
    console.log(`    deadline_iso:    ${deadlineISO}`);
    console.log();
  }

  const first = await invokeOnce(
    baseUrl,
    token,
    targetDID,
    { task_id: taskId, capability, input, deadline_iso: deadlineISO },
    traceparent,
    idempotencyKey,
  );

  if (first.status === 200) {
    emitResult(first.body, opts.json);
    return;
  }
  if (first.status >= 400) {
    emitError(first.status, first.body, opts.json);
    process.exitCode = 1;
    return;
  }
  if (first.status === 202) {
    if (!opts.json) {
      console.log(
        `  Accepted (async). Polling ${first.body?.status_url ?? "<missing status_url>"} every ${opts.pollIntervalMs ?? DEFAULT_POLL_MS}ms`,
      );
    }
    await pollUntilDone(
      baseUrl,
      token,
      first.body?.status_url,
      deadlineS * 1000,
      opts.pollIntervalMs ?? DEFAULT_POLL_MS,
      Boolean(opts.json),
    );
    return;
  }
  // Other 2xx is unexpected; surface raw.
  emitResult(first.body, opts.json);
}

async function pollUntilDone(
  baseUrl: string,
  token: string,
  statusUrl: string | undefined,
  budgetMs: number,
  intervalMs: number,
  asJSON: boolean,
): Promise<void> {
  if (!statusUrl) {
    console.error("  Error: 202 response missing status_url; can't poll");
    process.exitCode = 1;
    return;
  }
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await pollStatus(baseUrl, token, statusUrl);
    if (poll.status === 200) {
      emitResult(poll.body, asJSON);
      return;
    }
    if (poll.status === 410) {
      emitError(410, poll.body, asJSON);
      process.exitCode = 1;
      return;
    }
    if (poll.status >= 400) {
      emitError(poll.status, poll.body, asJSON);
      process.exitCode = 1;
      return;
    }
    // 202 still pending — keep polling.
  }
  console.error("  Timeout: deadline exceeded; task may still complete");
  process.exitCode = 1;
}

function emitResult(body: unknown, asJSON?: boolean): void {
  if (asJSON) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const b = body as any;
  console.log();
  console.log(`  ✓ Completed`);
  if (b?.task_id) console.log(`    task_id:               ${b.task_id}`);
  if (b?.evidence_envelope_hash)
    console.log(`    evidence_envelope_hash: ${b.evidence_envelope_hash}`);
  if (b?.traceparent)
    console.log(`    traceparent:           ${b.traceparent}`);
  if (b?.completed_at)
    console.log(`    completed_at:          ${b.completed_at}`);
  if (b?.output !== undefined) {
    console.log(`    output:`);
    console.log(
      JSON.stringify(b.output, null, 2)
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
  console.log();
}

function emitError(status: number, body: unknown, asJSON?: boolean): void {
  if (asJSON) {
    console.error(JSON.stringify({ status, body }, null, 2));
    return;
  }
  const b = body as any;
  const code = b?.error?.code ?? b?.code ?? "?";
  const message = b?.error?.message ?? b?.error ?? "(no message)";
  console.error(`  ✗ HTTP ${status} ${code}: ${message}`);
  if (b?.task_id) {
    console.error(`    original_task_id: ${b.task_id}`);
  }
  if (status === 429 && b?.retry_after_seconds) {
    console.error(`    retry_after_seconds: ${b.retry_after_seconds}`);
  }
}

export function registerA2ACommand(program: Command): void {
  const cmd = program
    .command("a2a")
    .description("Agent-to-agent (A2A) operations via BrainstormRouter mesh");

  cmd
    .command("invoke <target_did> <capability>")
    .description("Invoke an agent capability via the mesh broker")
    .option("--input <json>", "JSON input payload, or '-' to read from stdin")
    .option("--base <url>", "BR base URL (default $BRAINSTORM_BR_URL)")
    .option("--token <token>", "Bearer token (default $BRAINSTORM_API_KEY)")
    .option(
      "--poll-interval-ms <ms>",
      "Polling interval for async responses",
      (v) => parseInt(v, 10),
      DEFAULT_POLL_MS,
    )
    .option(
      "--deadline <seconds>",
      "Hard timeout for the invocation",
      (v) => parseInt(v, 10),
      DEFAULT_DEADLINE_S,
    )
    .option("--json", "Output JSON (no human-readable banner)")
    .action(
      async (targetDID: string, capability: string, opts: InvokeOptions) => {
        // Commander awaits the returned promise. Without the surrounding
        // try/catch, fetch rejections (DNS / refused / invalid date math)
        // would hit the process-level unhandled-rejection handler and exit 0,
        // masking failures for any caller scripting around the CLI.
        try {
          await runInvoke(targetDID, capability, opts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            console.error(JSON.stringify({ status: 0, error: msg }, null, 2));
          } else {
            console.error(`  ✗ a2a invoke failed: ${msg}`);
          }
          process.exitCode = 1;
        }
      },
    );
}

// Exported for tests.
export const __test = {
  invokeOnce,
  pollStatus,
  emitResult,
  emitError,
};
