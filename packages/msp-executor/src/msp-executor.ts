// MspExecutor — `ToolExecutor` implementation that dispatches a
// CommandEnvelope's tool/params via HTTP to BrainstormMSP's god-mode
// REST API.
//
// Wire contract (FROZEN at docs/endpoint-agent-protocol-v1.md, MSP side
// at brainstormmsp commit 4d582709):
//
//   POST {baseUrl}/api/v1/god-mode/execute
//     X-Brainstorm-Command-Id: {command_id}      ← injected correlation token
//     Idempotency-Key:        {command_id}      ← MUST equal X-Brainstorm-Command-Id
//     Authorization:          Bearer {apiKey}    ← service_key OR jwt
//     Content-Type:           application/json
//
//     { "tool": "...", "params": { ... }, "simulate": false }
//
// MSP enforces the cross-header consistency check (commit 4d582709):
// if both X-Brainstorm-Command-Id and Idempotency-Key are present and
// they differ, MSP returns 400 IDEMPOTENCY_CORRELATION_MISMATCH. This
// executor sets them to the same value by construction — a mismatch
// from this code is an executor bug, not an MSP bug, and we map it to
// exit_code=124 so the operator's failure surface stays sharp.
//
// Exit code mapping (mirrors POSIX/run-parts conventions used in
// chv-executor.ts so the operator's mental model is the same across
// executors):
//
//   0    — tool succeeded
//   1+   — tool ran and reported a non-zero exit (preserved verbatim)
//   124  — transport / timeout / executor-bug failures (we never reached
//          a coherent MSP response). Parallels POSIX `timeout(1)` exit.
//   125  — MSP server error (5xx). MSP reached us but couldn't service.
//   126  — auth failure (401/403). Tool exists, executor can't reach it.
//   127  — tool not found (404).
//
// The endpoint-stub turns any non-zero exit into a `failed` CommandResult
// with `error.code = SANDBOX_TOOL_ERROR`, so the operator sees a clean
// failure rather than a stuck spinner.

import type {
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutorResult,
} from "@brainst0rm/endpoint-stub";

export type MspAuthMode = "service_key" | "jwt";

export interface MspExecutorLogger {
  info: (m: string) => void;
  error: (m: string) => void;
}

export interface MspExecutorOptions {
  /** MSP base URL, e.g. "https://brainstormmsp.ai" (no trailing slash required). */
  baseUrl: string;
  /**
   * Bearer token sent in the Authorization header. The value is used
   * verbatim regardless of `authMode`; the discriminator only controls
   * how callers describe the credential (and may affect logging /
   * future telemetry). MSP itself only sees `Authorization: Bearer …`.
   */
  apiKey: string;
  /**
   * Discriminator: "service_key" for impersonation tokens (operator-side
   * dispatch acting on behalf of a tenant) vs "jwt" for ordinary user
   * sessions. v1 treats them identically on the wire — but the
   * distinction is recorded here so future audit/telemetry can attribute
   * dispatches correctly.
   */
  authMode: MspAuthMode;
  /** Tenant id (msp_tenant_id). Reserved for telemetry/logging in v1. */
  tenantId: string;
  /** Per-call timeout. Defaults to 30_000ms (matches MSP's mutation budget). */
  defaultTimeoutMs?: number;
  /**
   * Injection point for tests. Defaults to global `fetch`. Production
   * callers leave this undefined.
   */
  fetch?: typeof fetch;
  /** Optional logger. Defaults to console with a `[msp-executor]` prefix. */
  logger?: MspExecutorLogger;
}

interface MspErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * `ToolExecutor` implementation that POSTs to MSP's god-mode REST API.
 *
 * Construct once with credentials + base URL; use `.execute` as the
 * `ToolExecutor` callable handed to `EndpointStub`:
 *
 *   const executor = new MspExecutor({ baseUrl, apiKey, authMode, tenantId });
 *   const stub = new EndpointStub({ ..., executor: executor.execute });
 */
export class MspExecutor {
  private readonly opts: MspExecutorOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly log: MspExecutorLogger;

  /**
   * Bound executor function suitable for passing straight to
   * `EndpointStub`. Stable identity across calls.
   */
  public readonly execute: ToolExecutor;

  constructor(opts: MspExecutorOptions) {
    this.opts = opts;
    // Use the provided fetch verbatim. Don't bind to globalThis when one
    // is injected — tests rely on call recording on their mock.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      // A non-positive default timeout would feed AbortSignal.timeout()
      // a value that aborts immediately or throws, depending on runtime.
      // Reject at construction so the misconfig surfaces during wiring,
      // not at first dispatch.
      throw new Error(
        `MspExecutor: defaultTimeoutMs must be a positive finite number; got ${opts.defaultTimeoutMs}`,
      );
    }
    this.log = opts.logger ?? {
      info: (m) => console.log(`[msp-executor] ${m}`),
      error: (m) => console.error(`[msp-executor] ${m}`),
    };
    this.execute = (ctx) => this.dispatch(ctx);
  }

  /**
   * Translate a CommandEnvelope's tool invocation into an HTTP POST
   * against MSP's god-mode endpoint, then translate the response back
   * to a `ToolExecutorResult`.
   *
   * Mapping `ToolExecutorContext` → HTTP request:
   *   command_id  → X-Brainstorm-Command-Id (injected correlation token)
   *               → Idempotency-Key          (must equal the above; MSP enforces)
   *   tool        → body.tool
   *   params      → body.params
   *   deadline_ms → AbortSignal.timeout(min(deadline_ms, defaultTimeoutMs))
   *
   * Mapping HTTP response → `ToolExecutorResult`:
   *   200 + {exit_code,stdout,stderr}    → preserved verbatim
   *   200 (no exit_code field)           → exit=0, stdout=JSON.stringify(body)
   *   400 IDEMPOTENCY_CORRELATION_MISMATCH → exit=124 (executor bug)
   *   401 / 403 (incl TENANT_MISMATCH)   → exit=126 (auth failure)
   *   404                                 → exit=127 (tool not found)
   *   5xx                                 → exit=125 (server error)
   *   network / timeout / abort          → exit=124 (transport error)
   */
  private async dispatch(
    ctx: ToolExecutorContext,
  ): Promise<ToolExecutorResult> {
    const url = `${stripTrailingSlash(this.opts.baseUrl)}/api/v1/god-mode/execute`;
    if (ctx.deadline_ms <= 0) {
      // A non-positive deadline means "already expired" in the dispatch
      // contract — fail fast as a transport-class error rather than
      // silently substituting `defaultTimeoutMs` (which would let an
      // expired dispatch run for up to 30s).
      this.log.error(
        `command ${ctx.command_id} → expired deadline_ms=${ctx.deadline_ms}`,
      );
      return {
        exit_code: 124,
        stdout: "",
        stderr: `msp-executor: deadline expired (${ctx.deadline_ms}ms)`,
      };
    }
    const timeoutMs = Math.min(ctx.deadline_ms, this.defaultTimeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.opts.apiKey}`,
      "X-Brainstorm-Command-Id": ctx.command_id,
      // The two MUST be equal: MSP rejects mismatches with 400
      // IDEMPOTENCY_CORRELATION_MISMATCH (commit 4d582709). Setting them
      // from a single source ensures we never trip the check from this
      // side.
      "Idempotency-Key": ctx.command_id,
      // Per protocol §13 + peer 12xnwqbb's federation design: forward
      // the cross-product correlation id so BR can join audit chains
      // across operator → relay → endpoint → MSP.
      "X-Correlation-Id": ctx.correlation_id,
    };

    const body = JSON.stringify({
      tool: ctx.tool,
      params: ctx.params,
      // simulate=false: operator already confirmed the dispatch upstream.
      // ChangeSet-gated tools are not handled in v1; if MSP returns the
      // CHANGESET_REQUIRED error path it'll surface as a non-zero exit.
      simulate: false,
    });

    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // AbortError, network failure, DNS failure, TLS failure — all
      // collapse to "we never reached a coherent response". Distinct
      // exit code (124) so operators can disambiguate from server-side
      // 5xx (125).
      const msg = (e as Error).message ?? String(e);
      this.log.error(
        `transport error for command ${ctx.command_id} → ${url}: ${msg}`,
      );
      return {
        exit_code: 124,
        stdout: "",
        stderr: `msp-executor: transport error: ${msg}`,
      };
    }

    const elapsedMs = Date.now() - t0;
    const status = resp.status;

    // Read the response body as text once; we may parse it as JSON or
    // forward verbatim to stderr depending on the status.
    let raw: string;
    try {
      raw = await resp.text();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.log.error(
        `failed reading response body for command ${ctx.command_id}: ${msg}`,
      );
      return {
        exit_code: 124,
        stdout: "",
        stderr: `msp-executor: response read failed: ${msg}`,
      };
    }

    if (status === 200) {
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        // 200 with non-JSON body — surface verbatim. This shouldn't
        // happen against MSP but we don't want to crash the dispatch
        // loop if it does.
        this.log.info(
          `command ${ctx.command_id} → 200 non-JSON body (${elapsedMs}ms)`,
        );
        return { exit_code: 0, stdout: raw, stderr: "" };
      }

      // Detect the explicit {exit_code, stdout, stderr} shape — that's
      // what the future MSP god-mode handler returns when it's literally
      // running a shell-command tool. For data-provider tools (most of
      // MSP's surface today) the response is a richer object that we
      // marshal as stdout JSON with exit_code=0.
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "exit_code" in (parsed as Record<string, unknown>)
      ) {
        const exitField = (parsed as { exit_code: unknown }).exit_code;
        if (typeof exitField !== "number" || !Number.isFinite(exitField)) {
          // Body has an `exit_code` field but it's not a finite number
          // (e.g. `"1"`, `null`, `NaN`). This is a protocol violation —
          // fail closed as a transport-class error so we don't
          // misclassify it as data-provider success (exit_code=0).
          this.log.error(
            `command ${ctx.command_id} → 200 malformed exit_code=` +
              `${JSON.stringify(exitField)} (${elapsedMs}ms)`,
          );
          return {
            exit_code: 124,
            stdout: "",
            stderr:
              `msp-executor: malformed 200 response: exit_code field ` +
              `present but not a finite number (got ${JSON.stringify(exitField)})`,
          };
        }
        const p = parsed as {
          exit_code: number;
          stdout?: unknown;
          stderr?: unknown;
        };
        this.log.info(
          `command ${ctx.command_id} → 200 exit=${p.exit_code} (${elapsedMs}ms)`,
        );
        return {
          exit_code: p.exit_code,
          stdout: typeof p.stdout === "string" ? p.stdout : "",
          stderr: typeof p.stderr === "string" ? p.stderr : "",
        };
      }

      this.log.info(
        `command ${ctx.command_id} → 200 (data-provider; ${elapsedMs}ms)`,
      );
      return {
        exit_code: 0,
        stdout: JSON.stringify(parsed),
        stderr: "",
      };
    }

    // Non-200 paths. Try to parse the body for an error code; fall back
    // to the raw text in stderr.
    const errBody = safeParseError(raw);
    const errCode = errBody.error?.code;
    const errMsg = errBody.error?.message ?? raw;

    if (status === 400 && errCode === "IDEMPOTENCY_CORRELATION_MISMATCH") {
      // This SHOULD be unreachable from this executor — we set both
      // headers from the same `ctx.command_id`. Hitting this branch
      // means either the executor was modified to derive them
      // differently or a proxy is rewriting one. Treat as a transport-
      // class failure (124) since the dispatch never logically ran.
      this.log.error(
        `command ${ctx.command_id} → 400 IDEMPOTENCY_CORRELATION_MISMATCH ` +
          `(executor bug — headers should always match; ${elapsedMs}ms)`,
      );
      return {
        exit_code: 124,
        stdout: "",
        stderr: `msp-executor: header consistency violation: ${errMsg}`,
      };
    }

    if (status === 401 || status === 403) {
      // 403 covers the TENANT_MISMATCH path drafted in the spec patch
      // by dttytevx; 401 covers UNAUTHORIZED.
      this.log.error(
        `command ${ctx.command_id} → ${status} ${errCode ?? "auth"} ` +
          `(${elapsedMs}ms)`,
      );
      return {
        exit_code: 126,
        stdout: "",
        stderr: `msp-executor: auth error (${status}${errCode ? ` ${errCode}` : ""}): ${errMsg}`,
      };
    }

    if (status === 404) {
      this.log.error(
        `command ${ctx.command_id} → 404 ${errCode ?? "tool not found"} ` +
          `(${elapsedMs}ms)`,
      );
      return {
        exit_code: 127,
        stdout: "",
        stderr: `msp-executor: tool unknown (404${errCode ? ` ${errCode}` : ""}): ${errMsg}`,
      };
    }

    if (status >= 500 && status < 600) {
      this.log.error(
        `command ${ctx.command_id} → ${status} server error (${elapsedMs}ms)`,
      );
      return {
        exit_code: 125,
        stdout: "",
        // Forward the raw body so the operator can diagnose the upstream
        // failure without round-tripping into MSP logs.
        stderr: `msp-executor: server error (${status}): ${raw}`,
      };
    }

    // Anything else (e.g. 4xx that's neither idempotency, auth, nor 404
    // — like 400 VALIDATION, 400 CHANGESET_REQUIRED, 413 body too large,
    // 429 RATE_LIMITED) is surfaced as a generic non-zero exit. Use 1
    // (NOT 125, which is reserved for 5xx) so operators don't read a
    // tool-rejection as an MSP server failure.
    this.log.error(
      `command ${ctx.command_id} → ${status} ${errCode ?? "unclassified"} ` +
        `(${elapsedMs}ms)`,
    );
    return {
      exit_code: 1,
      stdout: "",
      stderr: `msp-executor: unexpected status (${status}${errCode ? ` ${errCode}` : ""}): ${errMsg}`,
    };
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function safeParseError(text: string): MspErrorBody {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as MspErrorBody;
    if (parsed !== null && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}
