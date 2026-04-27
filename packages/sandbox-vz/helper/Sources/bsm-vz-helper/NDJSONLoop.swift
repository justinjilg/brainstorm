// NDJSONLoop.swift
//
// Reads one JSON request per line from stdin, dispatches into a
// VMHostProtocol, writes one matching response per line to stdout.
// Unsolicited `event` frames may be emitted by the VMHost on its own
// schedule (lifecycle transitions, guest unreachability, panics) — they
// are not initiated here.
//
// Loop exits when:
//   - stdin reaches EOF (parent closed the pipe)
//   - we receive a `shutdown` request and successfully ack it
//   - a fatal helper-side bug fires (we emit a helper_panic event then
//     exit with HELPER_EXIT_INTERNAL_BUG)

import Foundation

final class NDJSONLoop {
    private let host: VMHostProtocol
    private let stdin: FileHandle
    private let stdout: FileHandle

    init(
        host: VMHostProtocol,
        stdin: FileHandle = FileHandle.standardInput,
        stdout: FileHandle = FileHandle.standardOutput
    ) {
        self.host = host
        self.stdin = stdin
        self.stdout = stdout
    }

    /// Block-and-process until stdin closes or `shutdown` lands.
    /// Returns the exit code the caller should propagate to the OS.
    func run() -> Int32 {
        var buffer = Data()
        while true {
            // Read in chunks; the parent's NDJSON writer flushes per
            // line so chunks ≈ lines, but we tolerate fragmentation.
            let chunk = stdin.availableData
            if chunk.isEmpty {
                // EOF.
                return HelperExitCode.ok.rawValue
            }
            buffer.append(chunk)

            while let nl = buffer.firstIndex(of: 0x0A /* \n */) {
                let lineData = buffer.subdata(in: 0..<nl)
                buffer.removeSubrange(0...nl)
                guard let line = String(data: lineData, encoding: .utf8),
                      !line.trimmingCharacters(in: .whitespaces).isEmpty
                else { continue }

                let exitedAfter = handleLine(line)
                if exitedAfter { return HelperExitCode.ok.rawValue }
            }
        }
    }

    /// Handle one NDJSON line. Returns true if the loop should terminate
    /// after this line (only set on a successful `shutdown`).
    private func handleLine(_ line: String) -> Bool {
        guard let lineData = line.data(using: .utf8) else {
            emitParseError(raw: line, message: "non-UTF8 input line")
            return false
        }

        let envelope: HelperRequestEnvelope
        do {
            envelope = try JSONDecoder().decode(HelperRequestEnvelope.self, from: lineData)
        } catch {
            emitParseError(raw: line, message: "JSON decode failed: \(error)")
            return false
        }

        switch envelope.kind {
        case .exec:
            write(host.handleExec(envelope))
            return false
        case .reset:
            write(host.handleReset(envelope))
            return false
        case .saveState:
            write(host.handleSaveState(envelope))
            return false
        case .restoreState:
            write(host.handleRestoreState(envelope))
            return false
        case .verify:
            write(host.handleVerify(envelope))
            return false
        case .shutdown:
            write(host.handleShutdown(envelope))
            return true
        }
    }

    /// Emit a `helper_panic` event when we see junk on stdin so the TS
    /// side has a structured signal. We do NOT exit on parse error; a
    /// misbehaving parent shouldn't take down the helper unless stdin
    /// closes.
    private func emitParseError(raw: String, message: String) {
        let ev = HelperEvent(
            event: "helper_panic",
            vmm_api_state: nil,
            message: "ndjson parse: \(message); raw=\(truncate(raw, 200))",
            ts: WireEncoding.nowISO8601()
        )
        write(ev)
    }

    private func write<T: Encodable>(_ value: T) {
        do {
            let line = try WireEncoding.line(value)
            stdout.write(Data(line.utf8))
        } catch {
            // Last-ditch: if we can't even encode our own response, dump
            // to stderr and carry on. The TS side will see a request
            // without a matching response and time out.
            FileHandle.standardError.write(
                Data("[bsm-vz-helper] failed to encode response: \(error)\n".utf8)
            )
        }
    }

    private func truncate(_ s: String, _ n: Int) -> String {
        if s.count <= n { return s }
        return String(s.prefix(n)) + "...[truncated]"
    }
}
