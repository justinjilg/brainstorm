// main.swift
//
// argv dispatch for `bsm-vz-helper`. Subcommands mirror
// helper-protocol.ts:
//
//   bsm-vz-helper preflight
//   bsm-vz-helper boot --kernel ... --rootfs ... [...]
//   bsm-vz-helper exec --command-id ... --tool ... --params ... --deadline-ms ...
//   bsm-vz-helper save-state --out PATH
//   bsm-vz-helper restore-state --from PATH
//
// All exit codes are defined in HelperExitCode (Protocol.swift) and must
// match the constants exported by helper-protocol.ts on the TS side.

import Foundation

let argv = CommandLine.arguments
let progName = (argv.first.map { ($0 as NSString).lastPathComponent }) ?? "bsm-vz-helper"

guard argv.count >= 2 else {
    printUsage()
    exit(HelperExitCode.bootConfigInvalid.rawValue)
}

let subcommand = argv[1]
let subArgs = Array(argv.dropFirst(2))

switch subcommand {
case "preflight":
    exit(Preflight.run())

case "boot":
    exit(runBoot(subArgs))

case "exec":
    exit(runExecOneShot(subArgs))

case "save-state":
    exit(runSaveStateOneShot(subArgs))

case "restore-state":
    exit(runRestoreStateOneShot(subArgs))

case "--help", "-h", "help":
    printUsage()
    exit(HelperExitCode.ok.rawValue)

default:
    FileHandle.standardError.write(
        Data("\(progName): unknown subcommand: \(subcommand)\n".utf8)
    )
    printUsage()
    exit(HelperExitCode.bootConfigInvalid.rawValue)
}

// MARK: - Subcommand drivers

func runBoot(_ args: [String]) -> Int32 {
    let parsed: VMHostBootConfig
    do {
        parsed = try parseBootArgs(args)
    } catch let err as VMHostError {
        emitBootFailure(code: err.wireCode, message: err.wireMessage)
        return HelperExitCode.bootConfigInvalid.rawValue
    } catch {
        emitBootFailure(code: "VZ_INTERNAL_BUG", message: "\(error)")
        return HelperExitCode.internalBug.rawValue
    }

    #if canImport(Virtualization)
    if #available(macOS 12.0, *) {
        let host = VMHost(config: parsed)
        do {
            let bootResult = try host.boot()
            // Emit boot result as the daemonization handshake (NO request_id
            // — boot_result is unsolicited; see helper-protocol.ts).
            do {
                let line = try WireEncoding.line(bootResult)
                FileHandle.standardOutput.write(Data(line.utf8))
            } catch {
                emitBootFailure(code: "VZ_INTERNAL_BUG", message: "\(error)")
                return HelperExitCode.internalBug.rawValue
            }

            // Switch into NDJSON-control-channel mode.
            let loop = NDJSONLoop(host: host)
            return loop.run()
        } catch let err as VMHostError {
            emitBootFailure(code: err.wireCode, message: err.wireMessage)
            switch err {
            case .configInvalid:
                return HelperExitCode.bootConfigInvalid.rawValue
            case .lifecycle:
                return HelperExitCode.vmLifecycleError.rawValue
            case .guestUnreachable:
                return HelperExitCode.guestUnreachable.rawValue
            case .timeoutHit:
                return HelperExitCode.timeoutErr.rawValue
            case .notSupportedOnPlatform:
                return HelperExitCode.preflightFail.rawValue
            case .fastSnapshotUnavailable, .internalBug:
                return HelperExitCode.internalBug.rawValue
            }
        } catch {
            emitBootFailure(code: "VZ_INTERNAL_BUG", message: "\(error)")
            return HelperExitCode.internalBug.rawValue
        }
    } else {
        emitBootFailure(
            code: "VZ_NOT_SUPPORTED",
            message: "bsm-vz-helper requires macOS 12+; see helper/README.md"
        )
        return HelperExitCode.preflightFail.rawValue
    }
    #else
    emitBootFailure(
        code: "VZ_NOT_SUPPORTED",
        message: "Built without Virtualization.framework — cannot boot"
    )
    return HelperExitCode.preflightFail.rawValue
    #endif
}

func runExecOneShot(_ args: [String]) -> Int32 {
    // The convenience exec subcommand is meant to forward to a running
    // helper via $XDG_RUNTIME_DIR/bsm-vz-helper.sock per the protocol
    // header. That UNIX-socket forwarder is deferred — VzSandbox uses
    // NDJSON-over-stdio directly so this convenience binary is unused
    // on the hot path.
    _ = args
    FileHandle.standardError.write(
        Data("bsm-vz-helper exec: forwarder is not implemented; use NDJSON-over-stdio (boot mode) instead\n".utf8)
    )
    return HelperExitCode.internalBug.rawValue
}

func runSaveStateOneShot(_ args: [String]) -> Int32 {
    // Same story: invoking save-state from the shell against an already-
    // running helper requires the UNIX-socket bridge above. Deferred.
    _ = args
    FileHandle.standardError.write(
        Data("bsm-vz-helper save-state: shell-form requires the UNIX-socket bridge (deferred); send a save_state NDJSON request through the boot-mode helper instead\n".utf8)
    )
    return HelperExitCode.internalBug.rawValue
}

func runRestoreStateOneShot(_ args: [String]) -> Int32 {
    _ = args
    FileHandle.standardError.write(
        Data("bsm-vz-helper restore-state: shell-form requires the UNIX-socket bridge (deferred); send a restore_state NDJSON request through the boot-mode helper instead\n".utf8)
    )
    return HelperExitCode.internalBug.rawValue
}

// MARK: - Boot argv parsing

func parseBootArgs(_ args: [String]) throws -> VMHostBootConfig {
    var kernel: String?
    var rootfs: String?
    var initrd: String?
    var cmdline: String = "console=hvc0 root=/dev/vda rw"
    var cpus: Int = 2
    var memoryMib: Int = 1024
    var savedState: String?

    var i = 0
    while i < args.count {
        let flag = args[i]
        let valueIndex = i + 1
        let needValue: () throws -> String = {
            guard valueIndex < args.count else {
                throw VMHostError.configInvalid("flag \(flag) requires a value")
            }
            return args[valueIndex]
        }
        switch flag {
        case "--kernel":
            kernel = try needValue(); i += 2
        case "--rootfs":
            rootfs = try needValue(); i += 2
        case "--initrd":
            initrd = try needValue(); i += 2
        case "--cmdline":
            cmdline = try needValue(); i += 2
        case "--cpus":
            guard let v = Int(try needValue()) else {
                throw VMHostError.configInvalid("--cpus requires an integer")
            }
            cpus = v; i += 2
        case "--memory-mib":
            guard let v = Int(try needValue()) else {
                throw VMHostError.configInvalid("--memory-mib requires an integer")
            }
            memoryMib = v; i += 2
        case "--saved-state":
            savedState = try needValue(); i += 2
        default:
            throw VMHostError.configInvalid("unknown flag: \(flag)")
        }
    }

    guard let k = kernel else {
        throw VMHostError.configInvalid("--kernel is required")
    }
    guard let r = rootfs else {
        throw VMHostError.configInvalid("--rootfs is required")
    }

    return VMHostBootConfig(
        kernelPath: k,
        rootfsPath: r,
        initrdPath: initrd,
        cmdline: cmdline,
        cpus: cpus,
        memoryMib: memoryMib,
        savedStatePath: savedState
    )
}

// MARK: - Helpers

func emitBootFailure(code: String, message: String) {
    let result = HelperBootResult(
        ok: false,
        vsock_cid: nil,
        vmm_api_state: .stopped,
        boot_path: "cold_boot",
        ts: WireEncoding.nowISO8601(),
        error: HelperErrorPayload(code: code, message: message)
    )
    if let line = try? WireEncoding.line(result) {
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}

func printUsage() {
    let usage = """
    bsm-vz-helper — Brainstorm sandbox-vz helper for Apple Virtualization.framework

    Usage:
      bsm-vz-helper preflight
      bsm-vz-helper boot --kernel PATH --rootfs PATH [--initrd PATH]
                         [--cmdline STR] [--cpus N] [--memory-mib N]
                         [--saved-state PATH]
      bsm-vz-helper exec --command-id UUID --tool NAME --params JSON --deadline-ms N
      bsm-vz-helper save-state --out PATH
      bsm-vz-helper restore-state --from PATH

    See packages/sandbox-vz/src/helper-protocol.ts for the wire contract.
    """
    FileHandle.standardError.write(Data((usage + "\n").utf8))
}
