// NDJSONLoopTests.swift
//
// Exercises NDJSONLoop against a FakeVMHost — no real VM, no
// Virtualization.framework. The bar these tests enforce:
//
//   1. One NDJSON line in -> one matching response line out.
//   2. request_id is preserved on every response (single-line check).
//   3. The `kind` field on each response matches the request kind's
//      expected response shape.
//   4. `shutdown` causes the loop to terminate cleanly.
//   5. Garbage input emits a `helper_panic` event without crashing.

import XCTest
import Foundation
@testable import bsm_vz_helper

final class FakeVMHost: VMHostProtocol {
    var isBooted: Bool = true

    var execCalls: [HelperRequestEnvelope] = []
    var resetCalls: [HelperRequestEnvelope] = []
    var saveCalls: [HelperRequestEnvelope] = []
    var restoreCalls: [HelperRequestEnvelope] = []
    var verifyCalls: [HelperRequestEnvelope] = []
    var shutdownCalls: [HelperRequestEnvelope] = []

    func boot() throws -> HelperBootResult {
        HelperBootResult(
            ok: true,
            vsock_cid: 3,
            vmm_api_state: .running,
            boot_path: "cold_boot",
            ts: "2026-04-27T00:00:00.000Z",
            error: nil
        )
    }

    func handleExec(_ env: HelperRequestEnvelope) -> HelperExecResponse {
        execCalls.append(env)
        return HelperExecResponse(
            request_id: env.request_id,
            command_id: env.command_id ?? "",
            exit_code: 0,
            stdout: "ok",
            stderr: "",
            evidence_hash: "sha256:fake",
            error: nil
        )
    }

    func handleReset(_ env: HelperRequestEnvelope) -> HelperResetResponse {
        resetCalls.append(env)
        return HelperResetResponse(
            request_id: env.request_id,
            reset_at: "2026-04-27T00:00:01.000Z",
            golden_hash: "sha256:golden",
            verification_passed: true,
            fs_hash: "sha256:fs",
            fs_hash_baseline: "sha256:fs",
            fs_hash_match: true,
            open_fd_count: 3,
            open_fd_count_baseline: 3,
            vmm_api_state: .running,
            expected_vmm_api_state: .running,
            divergence_action: "none",
            reset_path: "cold_boot",
            error: nil
        )
    }

    func handleSaveState(_ env: HelperRequestEnvelope) -> HelperSaveStateResponse {
        saveCalls.append(env)
        return HelperSaveStateResponse(
            request_id: env.request_id,
            ok: true,
            out_path: env.out_path ?? "",
            bytes_written: 42,
            error: nil
        )
    }

    func handleRestoreState(_ env: HelperRequestEnvelope) -> HelperRestoreStateResponse {
        restoreCalls.append(env)
        return HelperRestoreStateResponse(
            request_id: env.request_id,
            ok: true,
            vmm_api_state: .running,
            error: nil
        )
    }

    func handleVerify(_ env: HelperRequestEnvelope) -> HelperVerifyResponse {
        verifyCalls.append(env)
        return HelperVerifyResponse(
            request_id: env.request_id,
            fs_hash: "sha256:fs",
            fs_hash_baseline: env.fs_hash_baseline ?? "sha256:fs",
            fs_hash_match: true,
            open_fd_count: 3,
            open_fd_count_baseline: env.open_fd_count_baseline ?? 3,
            vmm_api_state: .running,
            expected_vmm_api_state: env.expected_vmm_api_state ?? .running,
            divergence_action: "none"
        )
    }

    func handleShutdown(_ env: HelperRequestEnvelope) -> HelperShutdownResponse {
        shutdownCalls.append(env)
        return HelperShutdownResponse(request_id: env.request_id, ok: true)
    }
}

final class NDJSONLoopTests: XCTestCase {

    /// Wire stdin and stdout as in-memory pipes so we can drive the
    /// loop deterministically and read what it emitted.
    private func makeHarness(input: String, host: VMHostProtocol)
        -> (loop: NDJSONLoop, output: () -> String, exitCode: Int32)
    {
        let inPipe = Pipe()
        let outPipe = Pipe()

        // Feed input then close the writer so the loop sees EOF.
        if let data = input.data(using: .utf8) {
            inPipe.fileHandleForWriting.write(data)
        }
        inPipe.fileHandleForWriting.closeFile()

        let loop = NDJSONLoop(
            host: host,
            stdin: inPipe.fileHandleForReading,
            stdout: outPipe.fileHandleForWriting
        )
        let exitCode = loop.run()

        outPipe.fileHandleForWriting.closeFile()
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let outString = String(data: outData, encoding: .utf8) ?? ""

        return (loop, { outString }, exitCode)
    }

    private func parseResponses(_ raw: String) -> [[String: Any]] {
        raw.split(separator: "\n").compactMap { line -> [String: Any]? in
            guard let d = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            else { return nil }
            return obj
        }
    }

    func testExecRoundtripPreservesRequestId() {
        let host = FakeVMHost()
        let req = """
        {"request_id":"r-1","kind":"exec","command_id":"c-1","tool":"echo","params":{"x":1},"deadline_ms":5000}
        """
        let h = makeHarness(input: req + "\n", host: host)
        let resps = parseResponses(h.output())

        XCTAssertEqual(host.execCalls.count, 1)
        XCTAssertEqual(host.execCalls[0].command_id, "c-1")
        XCTAssertEqual(resps.count, 1)
        XCTAssertEqual(resps[0]["request_id"] as? String, "r-1")
        XCTAssertEqual(resps[0]["kind"] as? String, "exec_response")
        XCTAssertEqual(resps[0]["command_id"] as? String, "c-1")
        // EOF after one line -> exit 0.
        XCTAssertEqual(h.exitCode, 0)
    }

    func testResetReturnsResetResponseShape() {
        let host = FakeVMHost()
        let req = """
        {"request_id":"r-2","kind":"reset"}
        """
        let h = makeHarness(input: req + "\n", host: host)
        let resps = parseResponses(h.output())

        XCTAssertEqual(host.resetCalls.count, 1)
        XCTAssertEqual(resps[0]["kind"] as? String, "reset_response")
        XCTAssertEqual(resps[0]["request_id"] as? String, "r-2")
        XCTAssertEqual(resps[0]["verification_passed"] as? Bool, true)
        XCTAssertNotNil(resps[0]["fs_hash"])
        XCTAssertNotNil(resps[0]["open_fd_count"])
        XCTAssertNotNil(resps[0]["divergence_action"])
        XCTAssertNotNil(resps[0]["reset_path"])
    }

    func testSaveStateAndRestoreState() {
        let host = FakeVMHost()
        let lines = [
            "{\"request_id\":\"r-3\",\"kind\":\"save_state\",\"out_path\":\"/tmp/s.bin\"}",
            "{\"request_id\":\"r-4\",\"kind\":\"restore_state\",\"from_path\":\"/tmp/s.bin\"}",
        ].joined(separator: "\n") + "\n"
        let h = makeHarness(input: lines, host: host)
        let resps = parseResponses(h.output())

        XCTAssertEqual(resps.count, 2)
        XCTAssertEqual(resps[0]["kind"] as? String, "save_state_response")
        XCTAssertEqual(resps[0]["out_path"] as? String, "/tmp/s.bin")
        XCTAssertEqual(resps[1]["kind"] as? String, "restore_state_response")
    }

    func testVerifyEchosBaselines() {
        let host = FakeVMHost()
        let req = """
        {"request_id":"r-5","kind":"verify","fs_hash_baseline":"sha256:abc","open_fd_count_baseline":7,"expected_vmm_api_state":"running"}
        """
        let h = makeHarness(input: req + "\n", host: host)
        let resps = parseResponses(h.output())

        XCTAssertEqual(host.verifyCalls.count, 1)
        XCTAssertEqual(resps[0]["kind"] as? String, "verify_response")
        XCTAssertEqual(resps[0]["fs_hash_baseline"] as? String, "sha256:abc")
        XCTAssertEqual(resps[0]["open_fd_count_baseline"] as? Int, 7)
        XCTAssertEqual(resps[0]["expected_vmm_api_state"] as? String, "running")
    }

    func testShutdownExitsLoop() {
        let host = FakeVMHost()
        // Two lines: an exec, then a shutdown. Loop should process both
        // and exit 0 after shutdown.
        let lines = [
            "{\"request_id\":\"r-6\",\"kind\":\"exec\",\"command_id\":\"c-6\",\"tool\":\"t\",\"params\":{},\"deadline_ms\":1000}",
            "{\"request_id\":\"r-7\",\"kind\":\"shutdown\"}",
        ].joined(separator: "\n") + "\n"
        let h = makeHarness(input: lines, host: host)
        let resps = parseResponses(h.output())

        XCTAssertEqual(resps.count, 2)
        XCTAssertEqual(resps[1]["kind"] as? String, "shutdown_response")
        XCTAssertEqual(resps[1]["ok"] as? Bool, true)
        XCTAssertEqual(host.shutdownCalls.count, 1)
        XCTAssertEqual(h.exitCode, 0)
    }

    func testGarbageInputEmitsHelperPanicEvent() {
        let host = FakeVMHost()
        let lines = "this is not json\n{\"request_id\":\"r-8\",\"kind\":\"shutdown\"}\n"
        let h = makeHarness(input: lines, host: host)
        let resps = parseResponses(h.output())

        // First frame: helper_panic event. Second: shutdown_response.
        XCTAssertGreaterThanOrEqual(resps.count, 2)
        let firstKinds = resps.compactMap { $0["kind"] as? String }
        XCTAssertTrue(firstKinds.contains("event"))
        XCTAssertTrue(firstKinds.contains("shutdown_response"))
        if let evt = resps.first(where: { ($0["kind"] as? String) == "event" }) {
            XCTAssertEqual(evt["event"] as? String, "helper_panic")
            XCTAssertNotNil(evt["ts"])
        }
    }
}

final class PreflightTests: XCTestCase {
    func testPreflightResultShape() {
        let r = Preflight.computeResult()
        // Shape required by helper-protocol.ts.
        XCTAssertFalse(r.macos_version.isEmpty)
        XCTAssertFalse(r.arch.isEmpty)
        // Arch should be one of the known strings.
        XCTAssertTrue(["arm64", "x86_64", "unknown"].contains(r.arch))
        // fast_snapshot_supported is a Bool — if macOS major >= 14 it
        // must be true; if < 14 it must be false.
        let v = ProcessInfo.processInfo.operatingSystemVersion
        if v.majorVersion >= 14 {
            XCTAssertTrue(r.fast_snapshot_supported)
        } else {
            XCTAssertFalse(r.fast_snapshot_supported)
        }
    }
}

final class ProtocolEncodingTests: XCTestCase {
    func testBootResultEncodesBytewise() throws {
        let r = HelperBootResult(
            ok: true,
            vsock_cid: 3,
            vmm_api_state: .running,
            boot_path: "cold_boot",
            ts: "2026-04-27T00:00:00.000Z",
            error: nil
        )
        let line = try WireEncoding.line(r)
        // Trailing newline, single line.
        XCTAssertTrue(line.hasSuffix("\n"))
        XCTAssertEqual(line.filter { $0 == "\n" }.count, 1)
        // Round-trip via JSONSerialization to confirm valid JSON.
        let data = Data(line.dropLast().utf8)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["kind"] as? String, "boot_result")
        XCTAssertEqual(obj?["ok"] as? Bool, true)
        XCTAssertEqual(obj?["boot_path"] as? String, "cold_boot")
        XCTAssertEqual(obj?["vmm_api_state"] as? String, "running")
    }

    func testExecResponseEncodesBytewise() throws {
        let r = HelperExecResponse(
            request_id: "r-x",
            command_id: "c-x",
            exit_code: 0,
            stdout: "hello",
            stderr: "",
            evidence_hash: "sha256:x",
            error: nil
        )
        let line = try WireEncoding.line(r)
        let data = Data(line.dropLast().utf8)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["kind"] as? String, "exec_response")
        XCTAssertEqual(obj?["request_id"] as? String, "r-x")
        XCTAssertEqual(obj?["command_id"] as? String, "c-x")
    }

    func testHelperEventEncodesWithoutVmmStateWhenNil() throws {
        let e = HelperEvent(
            event: "guest_unreachable",
            vmm_api_state: nil,
            message: "vsock connect refused",
            ts: "2026-04-27T00:00:00.000Z"
        )
        let line = try WireEncoding.line(e)
        let data = Data(line.dropLast().utf8)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["kind"] as? String, "event")
        XCTAssertEqual(obj?["event"] as? String, "guest_unreachable")
        // vmm_api_state was nil — should NOT appear in the encoded line.
        // (Default JSONEncoder omits nil optionals.)
        XCTAssertNil(obj?["vmm_api_state"])
    }
}
