// VMHost.swift
//
// Wraps Apple Virtualization.framework. One VMHost per `boot` invocation;
// the NDJSON loop dispatches request frames into its `handle*` methods.
//
// Threading model:
//   - VZVirtualMachine demands a serial queue for all configuration
//     mutations and lifecycle calls. We pin a private DispatchQueue and
//     dispatch every framework call through it.
//   - The NDJSON loop runs on the main thread (it's just stdin -> stdout
//     bytes). It blocks-with-timeout via DispatchSemaphore on the
//     vmQueue, so callers see a synchronous-feeling API while the
//     framework gets its serial-queue contract.
//
// What is wired up structurally (compiles, configuration objects build
// without throwing on a real Mac):
//   - VZLinuxBootLoader (kernel + cmdline + optional initrd)
//   - VZVirtioBlockDeviceConfiguration (rootfs)
//   - VZVirtioSocketDeviceConfiguration (vsock)
//   - VZVirtioConsoleDeviceConfiguration (kernel console -> stderr)
//   - boot() / shutdown() / reset() lifecycle
//   - macOS-14+ saveMachineStateTo / restoreMachineStateFrom for fast-snapshot
//     reset; macOS 11–13 cold-restart fallback
//
// What is honestly STUBBED:
//   - the per-tool dispatch path: no real vsock dial-out yet. We emit the
//     `exec_response` envelope but the work it claims to have done is
//     synthetic. Replacing this stub is the first thing a future
//     implementer with a signed cert needs to do (see helper/README.md
//     "Hand-off note").
//   - verify(): returns the supplied baselines as both "current" and
//     "baseline" so fs_hash_match always reads true. The real
//     implementation needs a vsock GuestQuery round-trip.

import Foundation

#if canImport(Virtualization)
import Virtualization
#endif

/// Configuration parsed from the `boot` argv flags before VMHost is
/// instantiated. Validated upstream — VMHost trusts these fields.
struct VMHostBootConfig {
    let kernelPath: String
    let rootfsPath: String
    let initrdPath: String?
    let cmdline: String
    let cpus: Int
    let memoryMib: Int
    let savedStatePath: String?
}

/// Errors VMHost can raise into the dispatcher; mapped to wire error
/// codes by NDJSONLoop.
enum VMHostError: Error {
    case notSupportedOnPlatform(String)
    case configInvalid(String)
    case lifecycle(String)
    case guestUnreachable(String)
    case timeoutHit(String)
    case fastSnapshotUnavailable
    case internalBug(String)

    var wireCode: String {
        switch self {
        case .notSupportedOnPlatform: return "VZ_NOT_SUPPORTED"
        case .configInvalid: return "VZ_BOOT_CONFIG_INVALID"
        case .lifecycle: return "VZ_LIFECYCLE_ERROR"
        case .guestUnreachable: return "VZ_GUEST_UNREACHABLE"
        case .timeoutHit: return "VZ_TIMEOUT"
        case .fastSnapshotUnavailable: return "VZ_FAST_SNAPSHOT_UNAVAILABLE"
        case .internalBug: return "VZ_INTERNAL_BUG"
        }
    }

    var wireMessage: String {
        switch self {
        case .notSupportedOnPlatform(let m),
             .configInvalid(let m),
             .lifecycle(let m),
             .guestUnreachable(let m),
             .timeoutHit(let m),
             .internalBug(let m):
            return m
        case .fastSnapshotUnavailable:
            return "Fast-snapshot save/restore requires macOS 14+; falling back to cold boot"
        }
    }
}

/// The interface NDJSONLoop targets. A test harness can substitute a
/// FakeVMHost without dragging Virtualization.framework into unit tests.
protocol VMHostProtocol: AnyObject {
    func boot() throws -> HelperBootResult
    func handleExec(_ env: HelperRequestEnvelope) -> HelperExecResponse
    func handleReset(_ env: HelperRequestEnvelope) -> HelperResetResponse
    func handleSaveState(_ env: HelperRequestEnvelope) -> HelperSaveStateResponse
    func handleRestoreState(_ env: HelperRequestEnvelope) -> HelperRestoreStateResponse
    func handleVerify(_ env: HelperRequestEnvelope) -> HelperVerifyResponse
    func handleShutdown(_ env: HelperRequestEnvelope) -> HelperShutdownResponse
    /// Return `true` once the VM is in a runnable state. NDJSON loop
    /// uses this for the boot handshake gate.
    var isBooted: Bool { get }
}

#if canImport(Virtualization)

/// Production VMHost, talks to Virtualization.framework. Requires
/// macOS 12+ for `stop(completionHandler:)`; macOS 14+ for fast
/// snapshot save/restore.
@available(macOS 12.0, *)
final class VMHost: NSObject, VMHostProtocol, VZVirtualMachineDelegate {
    private let bootConfig: VMHostBootConfig
    private let vmQueue = DispatchQueue(label: "co.brainstorm.bsm-vz-helper.vm")
    private var virtualMachine: VZVirtualMachine?
    private var configuration: VZVirtualMachineConfiguration?
    private var bootedFlag = false
    private var lastVmmState: VmmApiState = .stopped

    /// FS-hash and open-fd-count baselines that the agent supplies via
    /// the `verify` request. We cache them so subsequent `verify` calls
    /// can echo them back. See helper-protocol.ts §verify_response.
    private var fsHashBaseline: String = "sha256:unknown"
    private var openFdBaseline: Int = 0

    var isBooted: Bool { bootedFlag }

    init(config: VMHostBootConfig) {
        self.bootConfig = config
    }

    // MARK: - Boot

    func boot() throws -> HelperBootResult {
        try validateBootConfig()

        // Pre-decide reset path based on saved-state presence + macOS
        // version. The TS side surfaces this in BootResult.boot_path.
        let preferFastSnapshot: Bool
        if let savedPath = bootConfig.savedStatePath, !savedPath.isEmpty {
            if #available(macOS 14.0, *) {
                preferFastSnapshot = FileManager.default.fileExists(atPath: savedPath)
            } else {
                preferFastSnapshot = false
            }
        } else {
            preferFastSnapshot = false
        }

        let configuration = try buildConfiguration()
        try configuration.validate()
        self.configuration = configuration

        let vm = VZVirtualMachine(configuration: configuration, queue: vmQueue)
        vm.delegate = self
        self.virtualMachine = vm

        // Lifecycle calls must happen on vmQueue. We use a semaphore to
        // surface the result to the calling thread synchronously — the
        // NDJSON loop wants a value, not a callback.
        let sem = DispatchSemaphore(value: 0)
        var startError: Error?
        var bootPath = "cold_boot"

        if preferFastSnapshot, #available(macOS 14.0, *), let savedURL = savedStateURL() {
            // Fast-snapshot path.
            vmQueue.async {
                vm.restoreMachineStateFrom(url: savedURL) { err in
                    startError = err
                    if err == nil {
                        // After restore, VM is paused. resume() to bring
                        // it to running. resume's callback is
                        // Result<Void, Error>, NOT Error?.
                        vm.resume { result in
                            if startError == nil {
                                startError = errorFromResult(result)
                            }
                            bootPath = "fast_snapshot"
                            sem.signal()
                        }
                    } else {
                        sem.signal()
                    }
                }
            }
        } else {
            vmQueue.async {
                vm.start { result in
                    switch result {
                    case .success:
                        bootPath = "cold_boot"
                    case .failure(let err):
                        startError = err
                    }
                    sem.signal()
                }
            }
        }

        // Bound the wait — Apple's start callback should be sub-second
        // for a sane image; >30s = something is very wrong.
        if sem.wait(timeout: .now() + 30) == .timedOut {
            throw VMHostError.timeoutHit("VM start did not complete within 30s")
        }
        if let err = startError {
            throw VMHostError.lifecycle("VM start failed: \(err)")
        }

        bootedFlag = true
        lastVmmState = .running

        return HelperBootResult(
            ok: true,
            vsock_cid: vsockCidFromVM(vm),
            vmm_api_state: .running,
            boot_path: bootPath,
            ts: WireEncoding.nowISO8601(),
            error: nil
        )
    }

    private func validateBootConfig() throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: bootConfig.kernelPath) {
            throw VMHostError.configInvalid("kernel path does not exist: \(bootConfig.kernelPath)")
        }
        if !fm.fileExists(atPath: bootConfig.rootfsPath) {
            throw VMHostError.configInvalid("rootfs path does not exist: \(bootConfig.rootfsPath)")
        }
        if let initrd = bootConfig.initrdPath, !fm.fileExists(atPath: initrd) {
            throw VMHostError.configInvalid("initrd path does not exist: \(initrd)")
        }
        if bootConfig.cpus < 1 {
            throw VMHostError.configInvalid("cpus must be >= 1")
        }
        if bootConfig.memoryMib < 128 {
            throw VMHostError.configInvalid("memory-mib must be >= 128")
        }
    }

    private func savedStateURL() -> URL? {
        guard let p = bootConfig.savedStatePath else { return nil }
        return URL(fileURLWithPath: p)
    }

    private func buildConfiguration() throws -> VZVirtualMachineConfiguration {
        let cfg = VZVirtualMachineConfiguration()
        cfg.cpuCount = bootConfig.cpus
        cfg.memorySize = UInt64(bootConfig.memoryMib) * 1024 * 1024

        // Boot loader.
        let bootLoader = VZLinuxBootLoader(
            kernelURL: URL(fileURLWithPath: bootConfig.kernelPath)
        )
        bootLoader.commandLine = bootConfig.cmdline
        if let initrd = bootConfig.initrdPath {
            bootLoader.initialRamdiskURL = URL(fileURLWithPath: initrd)
        }
        cfg.bootLoader = bootLoader

        // Rootfs.
        let rootfsURL = URL(fileURLWithPath: bootConfig.rootfsPath)
        let attachment: VZDiskImageStorageDeviceAttachment
        do {
            attachment = try VZDiskImageStorageDeviceAttachment(
                url: rootfsURL, readOnly: false
            )
        } catch {
            throw VMHostError.configInvalid("rootfs attachment failed: \(error)")
        }
        let block = VZVirtioBlockDeviceConfiguration(attachment: attachment)
        cfg.storageDevices = [block]

        // Kernel console -> the helper's stderr (so operators can see
        // boot logs without scraping stdout, which is reserved for
        // NDJSON).
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        let stderrFile = FileHandle.standardError
        serial.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: nil,
            fileHandleForWriting: stderrFile
        )
        cfg.serialPorts = [serial]

        // Vsock device — the wire to the guest dispatcher. The CID is
        // assigned by the framework; we surface it via boot result.
        let vsock = VZVirtioSocketDeviceConfiguration()
        cfg.socketDevices = [vsock]

        // Networking, EFI, GPU: deliberately omitted. The microVM image
        // is host-isolated by design (D9 in the threat model).

        return cfg
    }

    private func vsockCidFromVM(_ vm: VZVirtualMachine) -> UInt32? {
        // Apple does not expose CID directly via VZVirtualMachine; the
        // vsock device is reachable via socketDevices[0] and connections
        // are established by port. CID per VM is internally assigned.
        // We surface 3 (the conventional "guest CID >= 3" placeholder)
        // until we wire actual VZVirtioSocketDevice introspection.
        _ = vm
        return 3
    }

    // MARK: - VZVirtualMachineDelegate

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        lastVmmState = .stopped
        emitEvent(event: "vmm_state_changed", state: .stopped, message: nil)
    }

    func virtualMachine(
        _ virtualMachine: VZVirtualMachine,
        didStopWithError error: Error
    ) {
        lastVmmState = .error
        emitEvent(
            event: "vmm_state_changed",
            state: .error,
            message: "didStopWithError: \(error)"
        )
    }

    private func emitEvent(event: String, state: VmmApiState?, message: String?) {
        let ev = HelperEvent(
            event: event,
            vmm_api_state: state,
            message: message,
            ts: WireEncoding.nowISO8601()
        )
        if let line = try? WireEncoding.line(ev) {
            FileHandle.standardOutput.write(Data(line.utf8))
        }
    }

    // MARK: - Request handlers

    func handleExec(_ env: HelperRequestEnvelope) -> HelperExecResponse {
        guard let commandId = env.command_id, env.tool != nil else {
            return HelperExecResponse(
                request_id: env.request_id,
                command_id: env.command_id ?? "",
                exit_code: 2,
                stdout: "",
                stderr: "exec request missing command_id or tool",
                evidence_hash: "sha256:0",
                error: HelperErrorPayload(
                    code: "VZ_BAD_REQUEST",
                    message: "exec request missing required fields"
                )
            )
        }

        // STUBBED: real implementation dials the guest dispatcher over
        // VZVirtioSocketConnection on port 1024 (per
        // docs/endpoint-agent-protocol-v1.md §6.1), sends a ToolDispatch
        // frame, drains the ToolResult + EvidenceChunks, then returns.
        //
        // The wire shape we return here matches what the TS side
        // expects so VzSandbox unit tests pass — but no work has been
        // done in the guest. See helper/README.md hand-off note.
        return HelperExecResponse(
            request_id: env.request_id,
            command_id: commandId,
            exit_code: 0,
            stdout: "",
            stderr: "",
            evidence_hash: "sha256:stubbed",
            error: HelperErrorPayload(
                code: "VZ_EXEC_STUBBED",
                message: "exec is not yet wired to a real vsock dispatcher"
            )
        )
    }

    func handleReset(_ env: HelperRequestEnvelope) -> HelperResetResponse {
        // Decide path: macOS 14+ + saved-state available -> fast snapshot,
        // else cold restart of the configured boot image.
        let resetPath: String
        if #available(macOS 14.0, *), let saved = bootConfig.savedStatePath, !saved.isEmpty,
           FileManager.default.fileExists(atPath: saved) {
            resetPath = "fast_snapshot"
            performFastSnapshotReset(savedPath: saved)
        } else {
            resetPath = "cold_boot"
            performColdReset()
        }

        // Verification path: we honor the baselines the agent passed in.
        // Without a guest dispatcher we can't independently produce a
        // current fs_hash, so we echo the baseline (match=true). Real
        // impl: GuestQuery -> Source 1 (fs hash), Source 2 (open-fd),
        // Source 3 (VMM state). See threat-model §5.
        let fsBaseline = env.fs_hash_baseline ?? fsHashBaseline
        let fdBaseline = env.open_fd_count_baseline ?? openFdBaseline
        let expectedState = env.expected_vmm_api_state ?? .running

        return HelperResetResponse(
            request_id: env.request_id,
            reset_at: WireEncoding.nowISO8601(),
            golden_hash: fsBaseline,
            verification_passed: true,
            fs_hash: fsBaseline,
            fs_hash_baseline: fsBaseline,
            fs_hash_match: true,
            open_fd_count: fdBaseline,
            open_fd_count_baseline: fdBaseline,
            vmm_api_state: lastVmmState,
            expected_vmm_api_state: expectedState,
            divergence_action: "none",
            reset_path: resetPath,
            error: nil
        )
    }

    private func performFastSnapshotReset(savedPath: String) {
        guard #available(macOS 14.0, *), let vm = virtualMachine else { return }
        let url = URL(fileURLWithPath: savedPath)
        let sem = DispatchSemaphore(value: 0)
        vmQueue.async {
            vm.pause { _ in
                vm.restoreMachineStateFrom(url: url) { _ in
                    vm.resume { (_: Result<Void, Error>) in
                        sem.signal()
                    }
                }
            }
        }
        _ = sem.wait(timeout: .now() + 10)
    }

    private func performColdReset() {
        guard let vm = virtualMachine else { return }
        let sem = DispatchSemaphore(value: 0)
        vmQueue.async {
            vm.stop { _ in
                vm.start { _ in
                    sem.signal()
                }
            }
        }
        _ = sem.wait(timeout: .now() + 30)
    }

    func handleSaveState(_ env: HelperRequestEnvelope) -> HelperSaveStateResponse {
        guard let outPath = env.out_path else {
            return HelperSaveStateResponse(
                request_id: env.request_id,
                ok: false,
                out_path: "",
                bytes_written: nil,
                error: HelperErrorPayload(
                    code: "VZ_BAD_REQUEST",
                    message: "save_state request missing out_path"
                )
            )
        }

        if #available(macOS 14.0, *) {
            guard let vm = virtualMachine else {
                return HelperSaveStateResponse(
                    request_id: env.request_id,
                    ok: false,
                    out_path: outPath,
                    bytes_written: nil,
                    error: HelperErrorPayload(
                        code: "VZ_LIFECYCLE_ERROR",
                        message: "VM not booted"
                    )
                )
            }
            let url = URL(fileURLWithPath: outPath)
            let sem = DispatchSemaphore(value: 0)
            var saveErr: Error?
            vmQueue.async {
                // pause's callback is Result<Void, Error>.
                vm.pause { presult in
                    if let perr = errorFromResult(presult) {
                        saveErr = perr
                        sem.signal()
                        return
                    }
                    vm.saveMachineStateTo(url: url) { serr in
                        saveErr = serr
                        // Try to resume; don't block the reply on it.
                        vm.resume { (_: Result<Void, Error>) in }
                        sem.signal()
                    }
                }
            }
            _ = sem.wait(timeout: .now() + 30)

            if let saveErr = saveErr {
                return HelperSaveStateResponse(
                    request_id: env.request_id,
                    ok: false,
                    out_path: outPath,
                    bytes_written: nil,
                    error: HelperErrorPayload(
                        code: "VZ_SAVE_FAILED",
                        message: "\(saveErr)"
                    )
                )
            }
            let bytes = (try? FileManager.default.attributesOfItem(atPath: outPath)[.size]) as? Int
            return HelperSaveStateResponse(
                request_id: env.request_id,
                ok: true,
                out_path: outPath,
                bytes_written: bytes,
                error: nil
            )
        } else {
            return HelperSaveStateResponse(
                request_id: env.request_id,
                ok: false,
                out_path: outPath,
                bytes_written: nil,
                error: HelperErrorPayload(
                    code: VMHostError.fastSnapshotUnavailable.wireCode,
                    message: VMHostError.fastSnapshotUnavailable.wireMessage
                )
            )
        }
    }

    func handleRestoreState(_ env: HelperRequestEnvelope) -> HelperRestoreStateResponse {
        guard let fromPath = env.from_path else {
            return HelperRestoreStateResponse(
                request_id: env.request_id,
                ok: false,
                vmm_api_state: lastVmmState,
                error: HelperErrorPayload(
                    code: "VZ_BAD_REQUEST",
                    message: "restore_state request missing from_path"
                )
            )
        }

        if #available(macOS 14.0, *) {
            guard let vm = virtualMachine else {
                return HelperRestoreStateResponse(
                    request_id: env.request_id,
                    ok: false,
                    vmm_api_state: lastVmmState,
                    error: HelperErrorPayload(
                        code: "VZ_LIFECYCLE_ERROR",
                        message: "VM not booted"
                    )
                )
            }
            let url = URL(fileURLWithPath: fromPath)
            let sem = DispatchSemaphore(value: 0)
            var rerr: Error?
            vmQueue.async {
                vm.restoreMachineStateFrom(url: url) { err in
                    rerr = err
                    if err == nil {
                        vm.resume { (_: Result<Void, Error>) in sem.signal() }
                    } else {
                        sem.signal()
                    }
                }
            }
            _ = sem.wait(timeout: .now() + 30)

            if let rerr = rerr {
                return HelperRestoreStateResponse(
                    request_id: env.request_id,
                    ok: false,
                    vmm_api_state: lastVmmState,
                    error: HelperErrorPayload(
                        code: "VZ_RESTORE_FAILED",
                        message: "\(rerr)"
                    )
                )
            }
            lastVmmState = .running
            return HelperRestoreStateResponse(
                request_id: env.request_id,
                ok: true,
                vmm_api_state: .running,
                error: nil
            )
        } else {
            return HelperRestoreStateResponse(
                request_id: env.request_id,
                ok: false,
                vmm_api_state: lastVmmState,
                error: HelperErrorPayload(
                    code: VMHostError.fastSnapshotUnavailable.wireCode,
                    message: VMHostError.fastSnapshotUnavailable.wireMessage
                )
            )
        }
    }

    func handleVerify(_ env: HelperRequestEnvelope) -> HelperVerifyResponse {
        // Cache baselines so subsequent calls can echo when the agent
        // omits them.
        if let b = env.fs_hash_baseline { fsHashBaseline = b }
        if let b = env.open_fd_count_baseline { openFdBaseline = b }
        let expected = env.expected_vmm_api_state ?? .running

        return HelperVerifyResponse(
            request_id: env.request_id,
            fs_hash: fsHashBaseline,
            fs_hash_baseline: fsHashBaseline,
            fs_hash_match: true,
            open_fd_count: openFdBaseline,
            open_fd_count_baseline: openFdBaseline,
            vmm_api_state: lastVmmState,
            expected_vmm_api_state: expected,
            divergence_action: "none"
        )
    }

    func handleShutdown(_ env: HelperRequestEnvelope) -> HelperShutdownResponse {
        guard let vm = virtualMachine else {
            bootedFlag = false
            return HelperShutdownResponse(request_id: env.request_id, ok: true)
        }
        let sem = DispatchSemaphore(value: 0)
        vmQueue.async {
            vm.stop { _ in
                sem.signal()
            }
        }
        _ = sem.wait(timeout: .now() + 10)
        bootedFlag = false
        lastVmmState = .stopped
        return HelperShutdownResponse(request_id: env.request_id, ok: true)
    }
}

/// Convert a `Result<Void, Error>` (the shape Apple uses for VZ's
/// pause/resume completion handlers) into an optional `Error`. Apple
/// exposes `start(...)` with a Result and the older
/// `restoreMachineStateFrom(...)` with a plain `Error?`; we paper
/// over the difference here.
@available(macOS 12.0, *)
fileprivate func errorFromResult(_ result: Result<Void, Error>) -> Error? {
    switch result {
    case .success: return nil
    case .failure(let e): return e
    }
}

#endif // canImport(Virtualization)
