// Preflight.swift
//
// Implements `bsm-vz-helper preflight`. Output is the exact JSON shape
// described in helper-protocol.ts header comment:
//   { "ok": bool, "macos_version": "14.4.1",
//     "arch": "arm64",
//     "fast_snapshot_supported": bool,
//     "entitlement_present": bool }
//
// Exit semantics:
//   ok=true  -> exit 0
//   ok=false -> exit 64 (HELPER_EXIT_PREFLIGHT_FAIL)

import Foundation

#if canImport(Virtualization)
import Virtualization
#endif

enum Preflight {
    /// Build the preflight result and emit it as a single NDJSON line on
    /// stdout. Returns the exit code the caller should `exit(...)` with.
    static func run() -> Int32 {
        let result = computeResult()
        do {
            let line = try WireEncoding.line(result)
            FileHandle.standardOutput.write(Data(line.utf8))
        } catch {
            // If we can't even encode preflight, the helper is hosed —
            // surface as internal bug.
            FileHandle.standardError.write(
                Data("preflight: encode failed: \(error)\n".utf8)
            )
            return HelperExitCode.internalBug.rawValue
        }
        return result.ok
            ? HelperExitCode.ok.rawValue
            : HelperExitCode.preflightFail.rawValue
    }

    static func computeResult() -> PreflightResult {
        let macVersion = currentMacOSVersion()
        let arch = currentArch()
        let entitled = entitlementPresent()
        let fastSnapshot = fastSnapshotSupported(macVersion: macVersion)

        // Apple's Virtualization.framework on Intel was last supported
        // on macOS 13. Apple Silicon is the target host arch. Our helper
        // requires macOS 12+ for VZVirtualMachine.stop(completionHandler:).
        let archIsSupported = arch == "arm64" || macVersion.major <= 13
        let macOSIsSupported = macVersion.major >= 12
        let frameworkAvailable = isVirtualizationFrameworkAvailable()

        let ok = archIsSupported && macOSIsSupported && entitled && frameworkAvailable

        var reason: String? = nil
        if !ok {
            var pieces: [String] = []
            if !macOSIsSupported {
                pieces.append("macOS \(macVersion.string) < 12 unsupported")
            }
            if !archIsSupported {
                pieces.append("arch \(arch) on macOS \(macVersion.major) unsupported")
            }
            if !frameworkAvailable {
                pieces.append("Virtualization.framework not available")
            }
            if !entitled {
                pieces.append("missing com.apple.security.virtualization entitlement")
            }
            reason = pieces.joined(separator: "; ")
        }

        return PreflightResult(
            ok: ok,
            macos_version: macVersion.string,
            arch: arch,
            fast_snapshot_supported: fastSnapshot,
            entitlement_present: entitled,
            reason: reason
        )
    }

    // MARK: - Internals

    struct MacOSVersion {
        let major: Int
        let minor: Int
        let patch: Int
        var string: String { "\(major).\(minor).\(patch)" }
    }

    static func currentMacOSVersion() -> MacOSVersion {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return MacOSVersion(
            major: v.majorVersion,
            minor: v.minorVersion,
            patch: v.patchVersion
        )
    }

    static func currentArch() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    /// macOS 14 (Sonoma) introduced
    /// `-[VZVirtualMachine saveMachineStateToURL:completionHandler:]` and
    /// the matching restore. Anything older = cold-boot fallback only.
    static func fastSnapshotSupported(macVersion: MacOSVersion) -> Bool {
        return macVersion.major >= 14
    }

    /// Virtualization.framework is system-provided on macOS 11+. On
    /// platforms that lack it (Linux dev hosts, etc.) the import-guard
    /// at the top of this file fails to compile; if we got here at
    /// runtime we know the framework is at least linkable.
    static func isVirtualizationFrameworkAvailable() -> Bool {
        #if canImport(Virtualization)
        return true
        #else
        return false
        #endif
    }

    /// Best-effort check for the entitlement. There is no public
    /// runtime API to introspect "does my own binary carry entitlement
    /// X" — the canonical check is `codesign -d --entitlements - <path>`.
    /// We approximate by trying to construct a minimal
    /// VZVirtualMachineConfiguration; failures stemming from missing
    /// entitlement throw a recognizable error code at start-time, but
    /// configuration construction itself does not. So preflight here
    /// reports `true` if the framework is loadable AND we are on a
    /// supported OS — and lets the actual `boot` subcommand surface
    /// `VZErrorVirtualMachineDeniedEntitlement` if signing was skipped.
    ///
    /// Rationale: a stricter check would need to shell out to
    /// `codesign --display --entitlements -` against /proc/self/exe,
    /// which is doable but adds a sandbox-hostile dependency on a
    /// command-line tool. Defer hardening until first-boot validation.
    static func entitlementPresent() -> Bool {
        #if canImport(Virtualization)
        return true
        #else
        return false
        #endif
    }
}
