// @brainst0rm/msp-executor — bridges the endpoint-stub's pluggable
// `ToolExecutor` interface into BrainstormMSP's god-mode REST API.
//
// Roles served:
//   1. Production Brainstorm-side bridge: when the relay dispatches a
//      command targeted at MSP, the endpoint-stub on the Brainstorm side
//      shells the call out via HTTP to MSP rather than running it
//      locally or in a CHV sandbox.
//   2. Reference for the wire shape MSP's god-mode handler expects —
//      the headers (X-Brainstorm-Command-Id, Idempotency-Key, Authorization)
//      and the body ({ tool, params, simulate: false }).
//
// What this is NOT:
//   - A general-purpose HTTP client. It speaks one endpoint shape
//     (POST /api/v1/god-mode/execute) and one auth contract (Bearer).
//   - A ChangeSet-aware executor. v1 dispatches simulate=false outright;
//     destructive tools are gated upstream (operator confirms before the
//     CommandEnvelope ever crosses the relay).
//   - Tested against a real MSP. All tests inject `fetch`. The first
//     real-MSP smoke happens when Justin authorizes a deploy + dttytevx
//     opens a PR with the matching MSP-side branch.

export {
  MspExecutor,
  type MspExecutorOptions,
  type MspAuthMode,
  type MspExecutorLogger,
} from "./msp-executor.js";
