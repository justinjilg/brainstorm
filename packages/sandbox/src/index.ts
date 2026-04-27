// @brainst0rm/sandbox — microVM sandbox abstraction for the Brainstorm
// endpoint agent.
//
// Purpose:
//   Phase 3 of the endpoint-dispatch plan (docs/endpoint-agent-plan.md §5)
//   adds real sandbox isolation between the brainstorm-agent and the tools
//   it executes. This package owns the cross-backend interface, plus the
//   Linux/Cloud-Hypervisor backend (P3.1a). The macOS/VF backend (P3.1b)
//   is a separate work package that targets the same interface.
//
//   The interface here is also the contract the production Go agent
//   (crd4sdom, P3.3) must satisfy in Go.
//
// Honesty:
//   This package was scaffolded on Darwin. The Cloud Hypervisor backend
//   has NOT been booted in this checkout. Calling `boot()` on Darwin
//   throws `SandboxNotAvailableError` cleanly so a future Linux runner
//   gets the same code path with the env-detection flipping naturally.
//   See `packages/sandbox/README.md` for the first-light checklist.

export {
  type Sandbox,
  type SandboxBackend,
  type SandboxState,
  type ResetState,
  type SandboxResetState,
  type VerificationDetails,
  type VmmApiState,
  type ToolInvocation,
  type ToolExecution,
  makeVerificationDetails,
} from "./sandbox.js";

export {
  SandboxError,
  SandboxNotAvailableError,
  SandboxBootError,
  SandboxToolTimeoutError,
  SandboxToolError,
  SandboxResetError,
  SandboxResetDivergenceError,
  SandboxVsockHandshakeError,
  SandboxVsockFrameTooLargeError,
} from "./errors.js";

export {
  ChvSandbox,
  type ChvSandboxDeps,
  type VsockGuestQueryClient,
} from "./chv/chv-sandbox.js";

export {
  ChRemote,
  type ChRemoteOptions,
  type ExecFileFn,
  defaultExecFile,
  normaliseVmmState,
} from "./chv/chv-remote.js";

export {
  defaultHashFile,
  type HashFileFn,
  FS_HASH_NOT_CONFIGURED,
} from "./chv/chv-overlay-hash.js";

export {
  type ChvSandboxConfig,
  type KernelConfig,
  type RootfsConfig,
  type VsockConfig,
  DEFAULT_KERNEL_CMDLINE,
  DEFAULT_VSOCK_CID,
  DEFAULT_CPUS,
  DEFAULT_MEM_MIB,
} from "./chv/chv-config.js";

export { isChvSupportedHost, buildChvArgv } from "./chv/chv-process.js";
