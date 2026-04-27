// @brainst0rm/sandbox-vz — public surface.
//
// macOS Apple Virtualization.framework (VZ) backend for the Brainstorm
// endpoint-agent sandbox abstraction. Sibling to @brainst0rm/sandbox
// (Cloud Hypervisor / Linux). See README for the threat-model context,
// entitlement requirements, and Swift helper deployment story.

export { VzSandbox } from "./vz-sandbox.js";
export type {
  ExecuteToolRequest,
  ExecuteToolResult,
  Sandbox,
  SandboxResetState,
  VerificationDetails,
  VmmApiState,
  VzBootConfig,
} from "./types.js";
export type {
  HelperBootResult,
  HelperEvent,
  HelperExecRequest,
  HelperExecResponse,
  HelperRequest,
  HelperRequestKind,
  HelperResetRequest,
  HelperResetResponse,
  HelperResponse,
  HelperRestoreStateRequest,
  HelperRestoreStateResponse,
  HelperSaveStateRequest,
  HelperSaveStateResponse,
  HelperShutdownRequest,
  HelperShutdownResponse,
  HelperVerifyRequest,
  HelperVerifyResponse,
} from "./helper-protocol.js";
export {
  HELPER_EXIT_OK,
  HELPER_EXIT_PREFLIGHT_FAIL,
  HELPER_EXIT_BOOT_CONFIG_INVALID,
  HELPER_EXIT_VM_LIFECYCLE_ERROR,
  HELPER_EXIT_GUEST_UNREACHABLE,
  HELPER_EXIT_RESET_DIVERGENCE,
  HELPER_EXIT_TIMEOUT,
  HELPER_EXIT_INTERNAL_BUG,
} from "./helper-protocol.js";
