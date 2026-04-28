// `brainstorm dispatch <tool>` subcommand — operator-side WS client for
// the Brainstorm endpoint-agent relay (P1.2 milestone).
//
// Flow per protocol-v1 §4:
//   1. Open WS to relay at /v1/operator
//   2. Send signed OperatorHello (HMAC over canonical form, key derived
//      via HKDF-SHA-256 from vault-resolved API key per §3.2)
//   3. Receive OperatorHelloAck (server registers operator session)
//   4. Send signed DispatchRequest
//   5. Receive ChangeSetPreview, render to terminal
//   6. Prompt operator for confirmation (or auto-confirm with --yes)
//   7. Send ConfirmRequest with preview_hash
//   8. Stream ProgressEvents to terminal as they arrive
//   9. Receive terminal ResultEvent / ErrorEvent; exit with appropriate code

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import WebSocket from "ws";

import { deriveOperatorHmacKey, operatorHmac } from "@brainst0rm/relay";

interface DispatchCliOptions {
  endpoint: string;
  tool: string;
  paramsJson?: string;
  relayUrl?: string;
  yes?: boolean;
  noStreamProgress?: boolean;
  deadlineMs?: number;
  apiKey?: string;
  operatorId?: string;
  tenantId?: string;
  correlationId?: string;
}

type ExitCode =
  | 0 // success
  | 1 // tool error (non-zero exit_code in payload)
  | 2 // operator declined or preview-hash mismatch
  | 3 // auth / endpoint failure
  | 4 // timeout
  | 5; // protocol / connectivity error

/**
 * Run a single dispatch from the CLI. Returns the process exit code.
 */
export async function runDispatch(opts: DispatchCliOptions): Promise<ExitCode> {
  const config = await resolveConfig(opts);
  const ws = await openSocket(config.relayUrl);
  try {
    return await runSession({ ws, config, opts });
  } finally {
    try {
      ws.close(1000, "dispatch complete");
    } catch {
      // ignore
    }
  }
}

interface ResolvedConfig {
  relayUrl: string;
  apiKey: string;
  operatorId: string;
  tenantId: string;
  hmacKey: Uint8Array;
}

async function resolveConfig(
  opts: DispatchCliOptions,
): Promise<ResolvedConfig> {
  const relayUrl =
    opts.relayUrl ?? process.env.BRAINSTORM_RELAY_URL ?? "ws://127.0.0.1:8443";
  const apiKey = opts.apiKey ?? process.env.BRAINSTORM_OPERATOR_API_KEY ?? null;
  if (apiKey === null) {
    throw new Error(
      "operator API key required: set BRAINSTORM_OPERATOR_API_KEY or pass --api-key",
    );
  }
  const operatorId =
    opts.operatorId ?? process.env.BRAINSTORM_OPERATOR_ID ?? "operator@local";
  const tenantId =
    opts.tenantId ?? process.env.BRAINSTORM_TENANT_ID ?? "tenant-local";
  const hmacKey = deriveOperatorHmacKey({
    apiKey,
    operatorId,
    tenantId,
  });
  return { relayUrl, apiKey, operatorId, tenantId, hmacKey };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url + "/v1/operator");
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });
}

async function runSession(args: {
  ws: WebSocket;
  config: ResolvedConfig;
  opts: DispatchCliOptions;
}): Promise<ExitCode> {
  const { ws, config, opts } = args;

  const inbound = createInboundQueue(ws);

  // Step 1-3: OperatorHello → OperatorHelloAck
  const hello = signOperatorHello({
    operatorId: config.operatorId,
    tenantId: config.tenantId,
    hmacKey: config.hmacKey,
  });
  await sendJson(ws, hello);
  const helloAck = await inbound.next();
  if (helloAck.type !== "OperatorHelloAck") {
    if (helloAck.type === "ErrorEvent") {
      printError(helloAck);
      return 3;
    }
    console.error(`[dispatch] unexpected first frame: ${helloAck.type}`);
    return 5;
  }

  // Step 4: DispatchRequest
  const requestId = randomUUID();
  const correlationId = opts.correlationId ?? "corr-" + requestId;
  const dispatchReq = signDispatchRequest({
    requestId,
    correlationId,
    tool: opts.tool,
    params: parseParams(opts.paramsJson),
    targetEndpointId: opts.endpoint,
    operatorId: config.operatorId,
    tenantId: config.tenantId,
    hmacKey: config.hmacKey,
    autoConfirm: opts.yes === true,
    streamProgress: opts.noStreamProgress !== true,
    deadlineMs: opts.deadlineMs ?? 30_000,
  });
  await sendJson(ws, dispatchReq);

  // Step 5-6: ChangeSetPreview → operator confirm
  const previewFrame = await inbound.next();
  if (previewFrame.type === "ErrorEvent") {
    printError(previewFrame);
    return 3;
  }
  if (previewFrame.type !== "ChangeSetPreview") {
    console.error(
      `[dispatch] expected ChangeSetPreview, got ${previewFrame.type}`,
    );
    return 5;
  }
  const preview = previewFrame as unknown as {
    request_id: string;
    command_id: string;
    preview_summary: string;
    preview_hash: string;
    blast_radius: string;
    reversibility: string;
  };
  if (!opts.yes) {
    process.stdout.write("\n");
    process.stdout.write(`ChangeSet preview\n`);
    process.stdout.write(`  command_id:   ${preview.command_id}\n`);
    process.stdout.write(`  blast_radius: ${preview.blast_radius}\n`);
    process.stdout.write(`  reversibility: ${preview.reversibility}\n`);
    process.stdout.write(`  ${preview.preview_summary}\n\n`);
    const confirmed = await prompt("Proceed? [y/N]: ");
    if (!/^y(es)?$/i.test(confirmed.trim())) {
      await sendJson(ws, {
        type: "ConfirmRequest",
        request_id: preview.request_id,
        command_id: preview.command_id,
        preview_hash: preview.preview_hash,
        confirm: false,
      });
      const declineResult = await inbound.next();
      printError(declineResult);
      return 2;
    }
  }

  // Step 7: ConfirmRequest
  await sendJson(ws, {
    type: "ConfirmRequest",
    request_id: preview.request_id,
    command_id: preview.command_id,
    preview_hash: preview.preview_hash,
    confirm: true,
  });

  // Step 8-9: stream Progress + Result
  const dispatchDeadline = Date.now() + (opts.deadlineMs ?? 30_000) + 5000;
  while (Date.now() < dispatchDeadline) {
    const frame = await inbound.next();
    switch (frame.type) {
      case "ProgressEvent": {
        const p = frame as unknown as {
          lifecycle_state: string;
          progress?: { fraction?: number; message?: string };
        };
        const f = p.progress?.fraction;
        const msg = p.progress?.message ?? "";
        if (f !== undefined) {
          process.stdout.write(
            `[${(f * 100).toFixed(0)}%] ${p.lifecycle_state}: ${msg}\n`,
          );
        } else {
          process.stdout.write(`[--] ${p.lifecycle_state}: ${msg}\n`);
        }
        continue;
      }
      case "ResultEvent": {
        const r = frame as unknown as {
          lifecycle_state: string;
          payload?: { stdout?: string; stderr?: string; exit_code?: number };
          error?: { code: string; message: string };
        };
        if (r.lifecycle_state === "completed") {
          if (r.payload?.stdout) process.stdout.write(r.payload.stdout);
          if (r.payload?.stderr) process.stderr.write(r.payload.stderr);
          return (r.payload?.exit_code ?? 0) === 0 ? 0 : 1;
        }
        if (r.lifecycle_state === "failed") {
          console.error(
            `[dispatch] failed: ${r.error?.code ?? "unknown"}: ${r.error?.message ?? ""}`,
          );
          return 1;
        }
        if (r.lifecycle_state === "timed_out") {
          console.error(`[dispatch] timed out`);
          return 4;
        }
        return 5;
      }
      case "ErrorEvent":
        printError(frame);
        return mapErrorCode(frame as unknown as { code: string });
      default:
        // Unexpected frame; ignore
        continue;
    }
  }
  console.error(`[dispatch] no terminal event before deadline`);
  return 4;
}

// ---------------------------------------------------------------------------
// Frame helpers

interface Frame {
  type: string;
  [key: string]: unknown;
}

function createInboundQueue(ws: WebSocket): { next: () => Promise<Frame> } {
  const buffer: Frame[] = [];
  const waiters: Array<{
    resolve: (f: Frame) => void;
    reject: (e: Error) => void;
  }> = [];
  ws.on("message", (data) => {
    let text: string;
    if (data instanceof Buffer) text = data.toString("utf-8");
    else text = String(data);
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    const w = waiters.shift();
    if (w !== undefined) w.resolve(frame);
    else buffer.push(frame);
  });
  ws.on("close", (code, reason) => {
    const err = new Error(
      `WS closed: ${code} ${reason?.toString?.() ?? ""}`.trim(),
    );
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.reject(err);
    }
  });
  ws.on("error", (err) => {
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.reject(err);
    }
  });
  return {
    next: () =>
      new Promise<Frame>((resolve, reject) => {
        const buffered = buffer.shift();
        if (buffered !== undefined) {
          resolve(buffered);
        } else {
          waiters.push({ resolve, reject });
        }
      }),
  };
}

function sendJson(ws: WebSocket, frame: object): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(frame), (err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Signing

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return Buffer.from(s, "binary").toString("base64");
}

function signOperatorHello(args: {
  operatorId: string;
  tenantId: string;
  hmacKey: Uint8Array;
}): object {
  const hello = {
    type: "OperatorHello",
    operator: {
      kind: "human" as const,
      id: args.operatorId,
      auth_proof: { mode: "hmac" as const, signature: "" },
    },
    tenant_id: args.tenantId,
    client_protocol_version: "v1" as const,
  };
  const digest = operatorHmac(
    hello as unknown as Record<string, unknown>,
    args.hmacKey,
  );
  hello.operator.auth_proof.signature = bytesToBase64(digest);
  return hello;
}

function signDispatchRequest(args: {
  requestId: string;
  correlationId: string;
  tool: string;
  params: Record<string, unknown>;
  targetEndpointId: string;
  operatorId: string;
  tenantId: string;
  hmacKey: Uint8Array;
  autoConfirm: boolean;
  streamProgress: boolean;
  deadlineMs: number;
}): object {
  const req = {
    type: "DispatchRequest" as const,
    request_id: args.requestId,
    tool: args.tool,
    params: args.params,
    target_endpoint_id: args.targetEndpointId,
    tenant_id: args.tenantId,
    correlation_id: args.correlationId,
    operator: {
      kind: "human" as const,
      id: args.operatorId,
      auth_proof: { mode: "hmac" as const, signature: "" },
    },
    options: {
      auto_confirm: args.autoConfirm,
      stream_progress: args.streamProgress,
      deadline_ms: args.deadlineMs,
    },
  };
  const digest = operatorHmac(
    req as unknown as Record<string, unknown>,
    args.hmacKey,
  );
  req.operator.auth_proof.signature = bytesToBase64(digest);
  return req;
}

function parseParams(json?: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("--params must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`--params parse failure: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------

function printError(frame: Frame): void {
  const f = frame as { code?: string; message?: string };
  console.error(`[dispatch] ${f.code ?? "ERROR"}: ${f.message ?? ""}`);
}

function mapErrorCode(frame: { code: string }): ExitCode {
  if (
    frame.code === "RELAY_OPERATOR_DECLINED" ||
    frame.code === "RELAY_PREVIEW_HASH_MISMATCH"
  ) {
    return 2;
  }
  if (
    frame.code.startsWith("AUTH_") ||
    frame.code === "RELAY_ENDPOINT_UNREACHABLE" ||
    frame.code === "RELAY_ENDPOINT_NOT_FOUND"
  ) {
    return 3;
  }
  if (
    frame.code === "RELAY_DEADLINE_EXCEEDED" ||
    frame.code === "ENDPOINT_NO_ACK"
  ) {
    return 4;
  }
  return 5;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
