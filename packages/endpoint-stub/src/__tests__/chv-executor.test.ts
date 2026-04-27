// ChvSandboxExecutor unit tests.
//
// Strategy: inject a mock `Sandbox` via the `factory` option so the
// executor's behaviour is exercised without booting a real microVM.
// The mock records every call and lets each test choose what
// boot/executeTool/shutdown does.
//
// What's covered:
//   1. Happy path: ToolInvocation forwarded faithfully, ToolExecution
//      translated faithfully back to ToolExecutorResult.
//   2. Boot failure: surfaces as exit_code=126 + stderr message; never
//      calls executeTool; still calls shutdown.
//   3. executeTool throw: surfaces as exit_code=125 + stderr message;
//      shutdown still runs.
//   4. command_id, tool, params, deadline_ms forwarded into the
//      ToolInvocation passed to Sandbox.executeTool (anti-mismapping).
//   5. deadline_ms forwarded — the executor doesn't add a parallel
//      wall-clock fence; the sandbox's own deadline is what's honoured.
//   6. shutdown is called on every exit path — happy, executor-throws,
//      and boot-fails.
//   7. (extra) stable executor.execute identity — useful for callers
//      that pass it to multiple stubs.

import { describe, it, expect } from "vitest";
import type {
  ResetState,
  Sandbox,
  SandboxBackend,
  SandboxState,
  ToolExecution,
  ToolInvocation,
} from "@brainst0rm/sandbox";

import { ChvSandboxExecutor } from "../chv-executor.js";
import type { ToolExecutorContext } from "../index.js";

// ---------------------------------------------------------------------------
// Mock Sandbox
// ---------------------------------------------------------------------------

interface MockSandboxOptions {
  bootImpl?: () => Promise<void>;
  executeToolImpl?: (inv: ToolInvocation) => Promise<ToolExecution>;
  shutdownImpl?: () => Promise<void>;
  resetImpl?: () => Promise<ResetState>;
}

interface MockSandboxRecorder {
  bootCalls: number;
  executeToolCalls: ToolInvocation[];
  shutdownCalls: number;
  resetCalls: number;
}

function createMockSandbox(opts: MockSandboxOptions = {}): {
  sandbox: Sandbox;
  recorder: MockSandboxRecorder;
} {
  const recorder: MockSandboxRecorder = {
    bootCalls: 0,
    executeToolCalls: [],
    shutdownCalls: 0,
    resetCalls: 0,
  };
  let status: SandboxState = "not_booted";

  const sandbox: Sandbox = {
    backend: "stub" as SandboxBackend,
    state: () => status,
    boot: async () => {
      recorder.bootCalls++;
      if (opts.bootImpl !== undefined) {
        await opts.bootImpl();
      }
      status = "ready";
    },
    executeTool: async (inv: ToolInvocation) => {
      recorder.executeToolCalls.push(inv);
      if (opts.executeToolImpl !== undefined) {
        return opts.executeToolImpl(inv);
      }
      return {
        exit_code: 0,
        stdout: `mock-stdout(tool=${inv.tool})`,
        stderr: "",
      };
    },
    reset: async () => {
      recorder.resetCalls++;
      if (opts.resetImpl !== undefined) {
        return opts.resetImpl();
      }
      throw new Error("reset not stubbed");
    },
    shutdown: async () => {
      recorder.shutdownCalls++;
      if (opts.shutdownImpl !== undefined) {
        await opts.shutdownImpl();
      }
      status = "not_booted";
    },
  };

  return { sandbox, recorder };
}

const FAKE_CONFIG = {
  apiSocketPath: "/tmp/test-api.sock",
  kernel: { path: "/tmp/test-kernel" },
  rootfs: { path: "/tmp/test-rootfs.img" },
  vsock: { socketPath: "/tmp/test-vsock.sock" },
};

const SILENT_LOGGER = { info: () => {}, error: () => {} };

function makeContext(
  overrides: Partial<ToolExecutorContext> = {},
): ToolExecutorContext {
  return {
    command_id: "cmd-test-001",
    tool: "echo",
    params: { message: "hello" },
    deadline_ms: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChvSandboxExecutor — happy path", () => {
  it("dispatches a tool through the sandbox and translates the result faithfully", async () => {
    const { sandbox, recorder } = createMockSandbox({
      executeToolImpl: async () => ({
        exit_code: 0,
        stdout: "ran-fine",
        stderr: "",
      }),
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const result = await executor.execute(makeContext());

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("ran-fine");
    expect(result.stderr).toBe("");
    expect(recorder.bootCalls).toBe(1);
    expect(recorder.executeToolCalls.length).toBe(1);
    expect(recorder.shutdownCalls).toBe(1);
  });
});

describe("ChvSandboxExecutor — input forwarding", () => {
  it("forwards command_id, tool, params, and deadline_ms verbatim into the ToolInvocation", async () => {
    const { sandbox, recorder } = createMockSandbox();
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    await executor.execute(
      makeContext({
        command_id: "cmd-forwarding-check",
        tool: "frobnicate",
        params: { count: 42, label: "alpha" },
        deadline_ms: 12_345,
      }),
    );

    expect(recorder.executeToolCalls.length).toBe(1);
    const inv = recorder.executeToolCalls[0];
    expect(inv.command_id).toBe("cmd-forwarding-check");
    expect(inv.tool).toBe("frobnicate");
    expect(inv.params).toEqual({ count: 42, label: "alpha" });
    expect(inv.deadline_ms).toBe(12_345);
  });
});

describe("ChvSandboxExecutor — boot failure", () => {
  it("translates a sandbox.boot() throw into exit_code=126 with stderr containing the error message", async () => {
    const { sandbox, recorder } = createMockSandbox({
      bootImpl: async () => {
        throw new Error("vsock handshake never succeeded within 30000ms");
      },
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const result = await executor.execute(makeContext());

    expect(result.exit_code).toBe(126);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("sandbox boot failed");
    expect(result.stderr).toContain("vsock handshake never succeeded");
    // executeTool MUST NOT be called when boot fails.
    expect(recorder.executeToolCalls.length).toBe(0);
    // shutdown MUST run on the boot-failure path too (idempotent contract).
    expect(recorder.shutdownCalls).toBe(1);
  });
});

describe("ChvSandboxExecutor — executeTool failure", () => {
  it("translates a sandbox.executeTool() throw into exit_code=125 with stderr containing the error message", async () => {
    const { sandbox, recorder } = createMockSandbox({
      executeToolImpl: async () => {
        throw new Error("guest crashed mid-dispatch");
      },
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const result = await executor.execute(makeContext());

    expect(result.exit_code).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("sandbox executeTool failed");
    expect(result.stderr).toContain("guest crashed mid-dispatch");
    expect(recorder.bootCalls).toBe(1);
    // shutdown MUST run after an executeTool throw — no leaked CHV processes.
    expect(recorder.shutdownCalls).toBe(1);
  });

  it("preserves a non-zero exit_code from the sandbox without translation", async () => {
    // This is the "tool ran but failed" case (vs. "executor errored"). The
    // sandbox returns a result; we faithfully forward exit_code=7. The
    // EndpointStub upstream is what turns this into a `failed` CommandResult.
    const { sandbox } = createMockSandbox({
      executeToolImpl: async () => ({
        exit_code: 7,
        stdout: "partial-output",
        stderr: "tool said no",
      }),
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const result = await executor.execute(makeContext());

    expect(result.exit_code).toBe(7);
    expect(result.stdout).toBe("partial-output");
    expect(result.stderr).toBe("tool said no");
  });
});

describe("ChvSandboxExecutor — deadline_ms is honoured (not exceeded by the executor)", () => {
  it("does not wait past the configured deadline; the sandbox's deadline_ms is what governs", async () => {
    // We model this by having executeTool resolve quickly when the
    // sandbox sees a small deadline. The executor itself does NOT add
    // a parallel wall-clock fence — that's the sandbox's job. This test
    // pins the contract: a sandbox that respects deadline_ms by returning
    // promptly results in a prompt executor return, and the deadline
    // value is passed through unmodified.
    let observedDeadline = 0;
    const { sandbox } = createMockSandbox({
      executeToolImpl: async (inv) => {
        observedDeadline = inv.deadline_ms;
        // Honour the deadline as a sandbox would: return immediately.
        return { exit_code: 0, stdout: "fast", stderr: "" };
      },
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const t0 = Date.now();
    const result = await executor.execute(makeContext({ deadline_ms: 50 }));
    const elapsed = Date.now() - t0;

    expect(observedDeadline).toBe(50);
    expect(result.exit_code).toBe(0);
    // We don't wait the full deadline — the sandbox returned immediately
    // and so did the executor. 250ms is generous slack for CI.
    expect(elapsed).toBeLessThan(250);
  });
});

describe("ChvSandboxExecutor — shutdown contract", () => {
  it("calls shutdown on the happy path", async () => {
    const { sandbox, recorder } = createMockSandbox();
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    await executor.execute(makeContext());

    expect(recorder.shutdownCalls).toBe(1);
  });

  it("calls shutdown even when boot throws", async () => {
    const { sandbox, recorder } = createMockSandbox({
      bootImpl: async () => {
        throw new Error("boot blew up");
      },
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    await executor.execute(makeContext());

    expect(recorder.shutdownCalls).toBe(1);
  });

  it("calls shutdown even when executeTool throws", async () => {
    const { sandbox, recorder } = createMockSandbox({
      executeToolImpl: async () => {
        throw new Error("exec blew up");
      },
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    await executor.execute(makeContext());

    expect(recorder.shutdownCalls).toBe(1);
  });

  it("swallows shutdown() errors so the executor's own result still wins", async () => {
    // If shutdown itself throws after a successful execution, we don't
    // want to mask the result the operator is waiting for. Log + swallow.
    const { sandbox } = createMockSandbox({
      executeToolImpl: async () => ({
        exit_code: 0,
        stdout: "ok",
        stderr: "",
      }),
      shutdownImpl: async () => {
        throw new Error("shutdown went sideways");
      },
    });
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const result = await executor.execute(makeContext());

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("ok");
  });
});

describe("ChvSandboxExecutor — cold-boot-per-dispatch lifecycle", () => {
  it("constructs a fresh sandbox via the factory on every dispatch", async () => {
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      const { sandbox } = createMockSandbox();
      return sandbox;
    };
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory,
      logger: SILENT_LOGGER,
    });

    await executor.execute(makeContext({ command_id: "c1" }));
    await executor.execute(makeContext({ command_id: "c2" }));
    await executor.execute(makeContext({ command_id: "c3" }));

    expect(factoryCalls).toBe(3);
  });

  it("exposes a stable `execute` reference across calls (safe to hand off)", async () => {
    const { sandbox } = createMockSandbox();
    const executor = new ChvSandboxExecutor({
      config: FAKE_CONFIG,
      factory: () => sandbox,
      logger: SILENT_LOGGER,
    });

    const fnRef1 = executor.execute;
    const fnRef2 = executor.execute;
    expect(fnRef1).toBe(fnRef2);
  });
});
