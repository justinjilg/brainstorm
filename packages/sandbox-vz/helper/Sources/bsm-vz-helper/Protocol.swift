// Protocol.swift
//
// NDJSON wire types — mirror of
// `packages/sandbox-vz/src/helper-protocol.ts`.
//
// The TypeScript side (`VzSandbox`) is the source of truth. Any drift here
// is a wire-protocol bug. Keep struct field names byte-equivalent to the
// TS interface field names so JSONEncoder with default key strategy
// emits the exact shape the TS side parses.

import Foundation

// MARK: - Exit codes

/// Helper exit codes — must match the constants in helper-protocol.ts.
/// These ARE the contract; the TypeScript side branches on them.
enum HelperExitCode: Int32 {
    case ok = 0
    case preflightFail = 64
    case bootConfigInvalid = 65
    case vmLifecycleError = 66
    case guestUnreachable = 67
    case resetDivergence = 68
    case timeoutErr = 69
    case internalBug = 70
}

// MARK: - VMM API state vocabulary

/// The four canonical VMM states across CHV (Linux) + VZ (macOS) backends.
/// Apple Virtualization.framework's native VZVirtualMachineState enum has
/// transient values (.starting, .stopping, .pausing, .resuming) that we
/// project onto these four when reporting upstream.
enum VmmApiState: String, Codable {
    case running
    case stopped
    case paused
    case error
}

// MARK: - Requests

enum HelperRequestKind: String, Codable {
    case exec
    case reset
    case saveState = "save_state"
    case restoreState = "restore_state"
    case verify
    case shutdown
}

/// A request frame from VzSandbox over stdin. We decode into this typed
/// envelope before dispatching to the kind-specific handler. The struct
/// is permissive: only `request_id` and `kind` are mandatory; payload
/// fields are decoded lazily via the kind-specific structs below.
struct HelperRequestEnvelope: Decodable {
    let request_id: String
    let kind: HelperRequestKind

    // Payload fields — all optional at the envelope level so we can
    // decode any kind through a single pass and let the dispatcher
    // pick the right ones.
    let command_id: String?
    let tool: String?
    let params: AnyCodable?
    let deadline_ms: Int?
    let out_path: String?
    let from_path: String?
    let fs_hash_baseline: String?
    let open_fd_count_baseline: Int?
    let expected_vmm_api_state: VmmApiState?
}

// MARK: - Responses

/// Boot result is the FIRST line on stdout after `bsm-vz-helper boot`
/// daemonizes — it has no `request_id` (it's the daemonization
/// handshake, not a reply to a request).
struct HelperBootResult: Encodable {
    let kind: String = "boot_result"
    let ok: Bool
    let vsock_cid: UInt32?
    let vmm_api_state: VmmApiState
    let boot_path: String  // "fast_snapshot" | "cold_boot"
    let ts: String
    let error: HelperErrorPayload?
}

struct HelperExecResponse: Encodable {
    let request_id: String
    let kind: String = "exec_response"
    let command_id: String
    let exit_code: Int
    let stdout: String
    let stderr: String
    let evidence_hash: String
    let error: HelperErrorPayload?
}

struct HelperResetResponse: Encodable {
    let request_id: String
    let kind: String = "reset_response"
    let reset_at: String
    let golden_hash: String
    let verification_passed: Bool
    let fs_hash: String
    let fs_hash_baseline: String
    let fs_hash_match: Bool
    let open_fd_count: Int
    let open_fd_count_baseline: Int
    let vmm_api_state: VmmApiState
    let expected_vmm_api_state: VmmApiState
    let divergence_action: String  // "none" | "halt"
    let reset_path: String  // "fast_snapshot" | "cold_boot"
    let error: HelperErrorPayload?
}

struct HelperSaveStateResponse: Encodable {
    let request_id: String
    let kind: String = "save_state_response"
    let ok: Bool
    let out_path: String
    let bytes_written: Int?
    let error: HelperErrorPayload?
}

struct HelperRestoreStateResponse: Encodable {
    let request_id: String
    let kind: String = "restore_state_response"
    let ok: Bool
    let vmm_api_state: VmmApiState
    let error: HelperErrorPayload?
}

struct HelperVerifyResponse: Encodable {
    let request_id: String
    let kind: String = "verify_response"
    let fs_hash: String
    let fs_hash_baseline: String
    let fs_hash_match: Bool
    let open_fd_count: Int
    let open_fd_count_baseline: Int
    let vmm_api_state: VmmApiState
    let expected_vmm_api_state: VmmApiState
    let divergence_action: String  // "none" | "halt"
}

struct HelperShutdownResponse: Encodable {
    let request_id: String
    let kind: String = "shutdown_response"
    let ok: Bool
}

/// Unsolicited event frames — emitted on stdout for VMM lifecycle
/// transitions, guest unreachability, helper panics. No `request_id`.
struct HelperEvent: Encodable {
    let kind: String = "event"
    let event: String  // "vmm_state_changed" | "guest_unreachable" | "helper_panic"
    let vmm_api_state: VmmApiState?
    let message: String?
    let ts: String
}

struct HelperErrorPayload: Encodable {
    let code: String
    let message: String
}

// MARK: - Preflight

/// Result of `bsm-vz-helper preflight` — exact shape from helper-protocol.ts:
///   { ok: bool,
///     macos_version: "14.4.1",
///     arch: "arm64",
///     fast_snapshot_supported: bool,
///     entitlement_present: bool }
struct PreflightResult: Encodable {
    let ok: Bool
    let macos_version: String
    let arch: String
    let fast_snapshot_supported: Bool
    let entitlement_present: Bool
    /// Optional human-readable diagnostic. NOT part of the strict TS
    /// shape, but TS will tolerate extra fields (JSON.parse doesn't
    /// reject unknowns). Useful when ok=false to surface why.
    let reason: String?
}

// MARK: - AnyCodable

/// Minimal JSON-passthrough container so we can route arbitrary
/// `params: Record<string, unknown>` through a strongly-typed Swift
/// envelope without modeling every possible tool param.
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.value = NSNull()
        } else if let v = try? container.decode(Bool.self) {
            self.value = v
        } else if let v = try? container.decode(Int.self) {
            self.value = v
        } else if let v = try? container.decode(Double.self) {
            self.value = v
        } else if let v = try? container.decode(String.self) {
            self.value = v
        } else if let v = try? container.decode([AnyCodable].self) {
            self.value = v.map { $0.value }
        } else if let v = try? container.decode([String: AnyCodable].self) {
            self.value = v.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "AnyCodable cannot decode value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let v as Bool:
            try container.encode(v)
        case let v as Int:
            try container.encode(v)
        case let v as Double:
            try container.encode(v)
        case let v as String:
            try container.encode(v)
        case let v as [Any]:
            try container.encode(v.map { AnyCodable($0) })
        case let v as [String: Any]:
            try container.encode(v.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "AnyCodable cannot encode \(type(of: value))"
                )
            )
        }
    }
}

// MARK: - Encoding helpers

enum WireEncoding {
    /// Encode a value to a single-line NDJSON UTF-8 string with trailing
    /// newline. The helper's stdout is NDJSON; pretty-printing or
    /// embedded newlines would corrupt the framing.
    static func line<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        // Default output is single-line — DO NOT enable .prettyPrinted.
        // sortedKeys is nice for deterministic test fixtures but not
        // wire-required.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        guard var s = String(data: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: [],
                    debugDescription: "non-UTF8 in encoded JSON"
                )
            )
        }
        // Defensive: strip any newlines a malformed encoder might have
        // injected, then append exactly one.
        s = s.replacingOccurrences(of: "\n", with: " ")
        s.append("\n")
        return s
    }

    /// Current ISO-8601 UTC timestamp with millisecond precision —
    /// matches the format the TS side emits in the rest of the protocol.
    static func nowISO8601() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}
