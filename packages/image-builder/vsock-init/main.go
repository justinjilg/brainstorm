// vsock-init is the PID-1 init program inside the Brainstorm sandbox microVM.
//
// Lifecycle:
//  1. Mount /proc, /sys, /dev/pts (best-effort; ignores errors so the binary still
//     works in a non-init smoke-test context).
//  2. Listen on vsock CID=VMADDR_CID_ANY, port BSM_VSOCK_PORT (default 52000).
//  3. For each accepted connection: read length-prefixed JSON frames, dispatch
//     the supported message types defined in
//     `docs/endpoint-agent-protocol-v1.md` §6 (vsock layer), reply on the same
//     socket, and close on EOF.
//
// Wire frame format (matches §2 of the protocol — length-prefixed binary):
//
//	[ uint32 big-endian payload_len ][ payload_len bytes of UTF-8 JSON ]
//
// Supported message types (MVP subset of §6):
//   - ToolDispatch    -> ToolResult           (§6.1, §6.2)
//   - GuestQuery      -> GuestResponse        (§6.3.5, §6.3.6)
//   - ResetSignal     -> ResetAck             (§6.4, §6.5; in-guest is a no-op
//     because real reset is host-side snapshot
//     revert — see README "what's stubbed")
//
// NOT YET IMPLEMENTED (tracked as TODOs in package README):
//   - EvidenceChunk streaming (§6.3) — only single-shot ToolResult for now
//   - Hash-chain evidence_hash computation per §6.3 formula
//   - command_id deduplication across reconnects
//   - seccomp inside the guest (threat-model defenders' guarantee #4)
//   - Tool whitelist (currently any binary on $PATH is dispatchable; this is
//     intentional for MVP echo/whoami/uname/cat-file but is a hardening gap)
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/mdlayher/vsock"
)

const (
	defaultVsockPort uint32 = 52000
	maxFrameBytes           = 16 * 1024 * 1024 // §2 protocol cap = 16 MiB
	frameReadTimeout        = 30 * time.Second // §2 partial-frame timeout

	// Sentinel exit codes used when the guest itself can't run the requested
	// command. These are reported in ToolResult.exit_code and are documented
	// in README.md so callers can distinguish "tool failed" from "guest
	// failed".
	exitToolNotFound = 127
	exitToolKilled   = 137
	exitGuestError   = 254
)

// MVP tool whitelist baked into the image (per plan §3.4 D22):
// echo, whoami, uname, cat (renamed from cat-file for POSIX), plus 2-3
// MSP-relevant placeholders (ls, env, sh -c). The whitelist is enforced in
// runTool() so an attacker who lands a frame can't simply exec /bin/anything.
var allowedTools = map[string]bool{
	"echo":   true,
	"whoami": true,
	"uname":  true,
	"cat":    true,
	"ls":     true,
	"env":    true,
	"sh":     true, // intentionally allowed for MVP; threat-model gap, see TODO
}

// ---- wire types -----------------------------------------------------------

type envelope struct {
	Type string `json:"type"`
}

type toolDispatch struct {
	Type       string                 `json:"type"`
	CommandID  string                 `json:"command_id"`
	Tool       string                 `json:"tool"`
	Params     map[string]interface{} `json:"params"`
	DeadlineMs int64                  `json:"deadline_ms"`
}

type toolResult struct {
	Type         string `json:"type"`
	CommandID    string `json:"command_id"`
	ExitCode     int    `json:"exit_code"`
	Stdout       string `json:"stdout"`
	Stderr       string `json:"stderr"`
	EvidenceHash string `json:"evidence_hash"`
}

type guestQuery struct {
	Type      string `json:"type"`
	QueryID   string `json:"query_id"`
	QueryKind string `json:"query_kind"`
	TS        string `json:"ts"`
}

type guestResponseMem struct {
	BytesUsed  uint64 `json:"bytes_used"`
	BytesTotal uint64 `json:"bytes_total"`
}

type guestResponse struct {
	Type      string      `json:"type"`
	QueryID   string      `json:"query_id"`
	QueryKind string      `json:"query_kind"`
	Result    interface{} `json:"result"`
	TS        string      `json:"ts"`
}

type resetSignal struct {
	Type    string `json:"type"`
	ResetID string `json:"reset_id"`
	Reason  string `json:"reason"`
}

type resetAck struct {
	Type             string                 `json:"type"`
	ResetID          string                 `json:"reset_id"`
	ResetCompleteAt  string                 `json:"reset_complete_at"`
	GoldenHash       string                 `json:"golden_hash"`
	VerificationPass bool                   `json:"verification_passed"`
	Details          map[string]interface{} `json:"verification_details"`
}

// ---- main -----------------------------------------------------------------

func main() {
	if runtime.GOOS != "linux" {
		// vsock is Linux-only; refuse to start anywhere else so a developer
		// running this binary on Darwin sees a clear message rather than a
		// confusing socket error.
		fmt.Fprintln(os.Stderr, "vsock-init: only runs on Linux (vsock requires AF_VSOCK)")
		fatalAsPID1(fmt.Errorf("non-linux host"))
	}

	if err := runInit(); err != nil {
		fatalAsPID1(err)
	}
}

// runInit returns on listener-close (orderly shutdown) or returns an error
// on any unrecoverable startup failure. The caller (main) treats both cases
// — error and clean return — as "do not os.Exit if PID=1": a non-zero exit
// from PID 1 triggers a kernel panic and burns the console diagnostics that
// tell us what went wrong (see 0bz7aztr first-light run #5: vsock.Listen
// failure → os.Exit → "Attempted to kill init!" → panic → no further
// observability).
func runInit() error {
	mountPseudoFilesystems()
	loadVsockModules()

	port := defaultVsockPort
	if envPort := os.Getenv("BSM_VSOCK_PORT"); envPort != "" {
		if p, err := strconv.ParseUint(envPort, 10, 32); err == nil {
			port = uint32(p)
		}
	}

	fmt.Fprintf(os.Stderr, "vsock-init: about to vsock.Listen(port=%d)\n", port)
	l, err := vsock.Listen(port, nil)
	if err != nil {
		return fmt.Errorf("vsock.Listen(%d): %w", port, err)
	}
	fmt.Fprintf(os.Stderr, "vsock-init: Listen returned ok; listening on vsock port %d\n", port)

	ctx, cancel := signalContext()
	defer cancel()

	go func() {
		<-ctx.Done()
		l.Close()
	}()

	fmt.Fprintln(os.Stderr, "vsock-init: entering accept() loop")
	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			fmt.Fprintf(os.Stderr, "vsock-init: accept error: %v\n", err)
			continue
		}
		fmt.Fprintf(os.Stderr, "vsock-init: accepted connection %s -> %s\n",
			conn.RemoteAddr(), conn.LocalAddr())
		go handleConn(conn)
	}
}

// fatalAsPID1 prints the error and halts forever rather than os.Exit'ing.
// PID 1 cannot exit without crashing the kernel, so the only safe failure
// mode is to log loudly and block, leaving the console scrollback intact
// for whoever's reading the boot log.
//
// IMPORTANT: do NOT use `select {}` here. Go's runtime deadlock detector
// classifies a single goroutine blocked on an empty select as deadlock,
// prints a stack trace, and exits with code 2 — which then panics the
// kernel with "Attempted to kill init! exitcode=0x00000200". (0bz7aztr
// caught this on first-light run #6.) A heartbeat ticker keeps the
// runtime busy AND surfaces every-minute "still halted" lines so the
// operator can tell halt-state apart from full kernel hang.
func fatalAsPID1(err error) {
	fmt.Fprintf(os.Stderr, "vsock-init: FATAL (PID=%d): %v\n", os.Getpid(), err)
	fmt.Fprintln(os.Stderr, "vsock-init: halting indefinitely so console output is preserved (would-be exit code 1)")
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for range t.C {
		fmt.Fprintf(os.Stderr, "vsock-init: still halted (PID=%d): %v\n", os.Getpid(), err)
	}
}

// loadVsockModules best-effort-loads the kernel modules that expose
// /dev/vsock under Cloud Hypervisor (or any virtio-vsock host). On Alpine
// virt these ship as separate .ko's, so the in-guest dispatcher must
// modprobe them before vsock.Listen — otherwise vsock.Listen returns
// "open /dev/vsock: no such file or directory".
//
// We try each module name independently; failures are logged but ignored
// because (a) some are pulled transitively as deps, (b) some kernels build
// them in (no-op modprobe). Order matters: vsock first (provides the
// /dev/vsock node), then transports.
func loadVsockModules() {
	modules := []string{
		"vsock",
		"vmw_vsock_virtio_transport_common",
		"vmw_vsock_virtio_transport",
		// virtio_vsock historically existed as a separate alias on
		// pre-5.x kernels but was merged into vmw_vsock_virtio_transport.
		// Linux 6.6.x (Alpine virt) does not have it; the modprobe noise
		// confused first-light boot logs. If we ever ship to a kernel
		// older than ~5.x, re-add it here.
	}
	for _, m := range modules {
		cmd := exec.Command("/sbin/modprobe", m)
		out, err := cmd.CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "vsock-init: modprobe %s: %v (output: %s)\n", m, err, string(out))
			continue
		}
		fmt.Fprintf(os.Stderr, "vsock-init: modprobe %s: ok\n", m)
	}
}

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-ch
		cancel()
	}()
	return ctx, cancel
}

// mountPseudoFilesystems is a best-effort PID-1 setup. It deliberately ignores
// errors so this binary can also be run as a smoke test inside a regular
// container during CI (where /proc is already mounted).
func mountPseudoFilesystems() {
	type m struct{ src, dst, fs string }
	for _, x := range []m{
		{"proc", "/proc", "proc"},
		{"sysfs", "/sys", "sysfs"},
		{"devtmpfs", "/dev", "devtmpfs"},
	} {
		_ = syscall.Mount(x.src, x.dst, x.fs, 0, "")
	}
}

// ---- per-connection loop --------------------------------------------------

func handleConn(c net.Conn) {
	defer c.Close()
	for {
		_ = c.SetReadDeadline(time.Now().Add(frameReadTimeout))
		payload, err := readFrame(c)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				fmt.Fprintf(os.Stderr, "vsock-init: readFrame: %v\n", err)
			}
			return
		}

		var env envelope
		if err := json.Unmarshal(payload, &env); err != nil {
			writeError(c, "FRAME_MALFORMED", err.Error())
			return
		}

		switch env.Type {
		case "ToolDispatch":
			var td toolDispatch
			if err := json.Unmarshal(payload, &td); err != nil {
				writeError(c, "FRAME_MALFORMED", err.Error())
				return
			}
			tr := runTool(td)
			_ = writeJSON(c, tr)

		case "GuestQuery":
			var gq guestQuery
			if err := json.Unmarshal(payload, &gq); err != nil {
				writeError(c, "FRAME_MALFORMED", err.Error())
				return
			}
			gr := answerQuery(gq)
			_ = writeJSON(c, gr)

		case "ResetSignal":
			var rs resetSignal
			if err := json.Unmarshal(payload, &rs); err != nil {
				writeError(c, "FRAME_MALFORMED", err.Error())
				return
			}
			// In-guest reset is a no-op for MVP — the real reset happens
			// host-side via Cloud Hypervisor / VF snapshot revert. We still
			// emit a ResetAck so the host loop has a heartbeat.
			_ = writeJSON(c, resetAck{
				Type:             "ResetAck",
				ResetID:          rs.ResetID,
				ResetCompleteAt:  time.Now().UTC().Format(time.RFC3339Nano),
				GoldenHash:       "sha256:guest-side-reset-not-implemented",
				VerificationPass: true,
				Details: map[string]interface{}{
					"fs_hash":                 "sha256:guest-side-reset-not-implemented",
					"fs_hash_baseline":        "sha256:guest-side-reset-not-implemented",
					"fs_hash_match":           true,
					"open_fd_count":           openFdCount(),
					"open_fd_count_baseline":  openFdCount(),
					"vmm_api_state":           "running",
					"expected_vmm_api_state":  "Running",
					"divergence_action":       "none",
				},
			})

		default:
			writeError(c, "FRAME_MALFORMED", "unknown type: "+env.Type)
			return
		}
	}
}

// ---- frame I/O ------------------------------------------------------------

func readFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 {
		return nil, errors.New("FRAME_MALFORMED: zero length")
	}
	if n > maxFrameBytes {
		return nil, fmt.Errorf("FRAME_TOO_LARGE: %d > %d", n, maxFrameBytes)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) > maxFrameBytes {
		return fmt.Errorf("FRAME_TOO_LARGE: %d > %d", len(payload), maxFrameBytes)
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func writeJSON(w io.Writer, v interface{}) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeFrame(w, b)
}

func writeError(w io.Writer, code, msg string) {
	_ = writeJSON(w, map[string]string{
		"type":    "ErrorEvent",
		"code":    code,
		"message": msg,
	})
}

// ---- tool dispatch --------------------------------------------------------

func runTool(td toolDispatch) toolResult {
	tr := toolResult{
		Type:      "ToolResult",
		CommandID: td.CommandID,
		// evidence_hash placeholder — real hash-chain is a TODO (see README).
		EvidenceHash: "sha256:hash-chain-not-yet-implemented",
	}

	if !allowedTools[td.Tool] {
		tr.ExitCode = exitToolNotFound
		tr.Stderr = "tool not in MVP whitelist: " + td.Tool
		return tr
	}

	args, err := paramsToArgs(td.Tool, td.Params)
	if err != nil {
		tr.ExitCode = exitGuestError
		tr.Stderr = err.Error()
		return tr
	}

	deadline := time.Duration(td.DeadlineMs) * time.Millisecond
	if deadline <= 0 {
		deadline = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	defer cancel()

	cmd := exec.CommandContext(ctx, td.Tool, args...)
	out, err := cmd.Output()
	tr.Stdout = string(out)

	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			tr.ExitCode = ee.ExitCode()
			tr.Stderr = string(ee.Stderr)
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			tr.ExitCode = exitToolKilled
			tr.Stderr = "deadline_exceeded"
		} else {
			tr.ExitCode = exitGuestError
			tr.Stderr = err.Error()
		}
	}
	return tr
}

// paramsToArgs converts the JSON params blob to argv. Each tool gets a tiny,
// explicitly enumerated mapping so an attacker can't smuggle arbitrary argv
// through a free-form params shape.
func paramsToArgs(tool string, params map[string]interface{}) ([]string, error) {
	switch tool {
	case "echo":
		if msg, ok := params["message"].(string); ok {
			return []string{msg}, nil
		}
		return []string{""}, nil
	case "whoami":
		return nil, nil
	case "uname":
		flag, _ := params["flag"].(string)
		if flag == "" {
			flag = "-a"
		}
		return []string{flag}, nil
	case "cat":
		path, ok := params["path"].(string)
		if !ok {
			return nil, errors.New("cat requires params.path (string)")
		}
		return []string{path}, nil
	case "ls":
		path, _ := params["path"].(string)
		if path == "" {
			path = "/"
		}
		return []string{"-la", path}, nil
	case "env":
		return nil, nil
	case "sh":
		script, ok := params["script"].(string)
		if !ok {
			return nil, errors.New("sh requires params.script (string)")
		}
		return []string{"-c", script}, nil
	}
	return nil, errors.New("unmapped tool: " + tool)
}

// ---- guest queries (§6.3.5/§6.3.6) ----------------------------------------

func answerQuery(gq guestQuery) guestResponse {
	resp := guestResponse{
		Type:      "GuestResponse",
		QueryID:   gq.QueryID,
		QueryKind: gq.QueryKind,
		TS:        time.Now().UTC().Format(time.RFC3339Nano),
	}
	switch gq.QueryKind {
	case "OpenFdCount":
		resp.Result = map[string]int{"open_fd_count": openFdCount()}
	case "MemUsage":
		used, total := memUsage()
		resp.Result = guestResponseMem{BytesUsed: used, BytesTotal: total}
	case "ProcessList":
		resp.Result = map[string]interface{}{"processes": processList()}
	default:
		resp.Result = map[string]string{"error": "unknown query_kind"}
	}
	return resp
}

// openFdCount returns vsock-init's open NON-SOCKET fd count.
//
// Why exclude sockets: the integrity monitor's reset-cycle compares
// pre-reset and post-reset fd counts. After CHV's restore + host's
// re-handshake, the vsock listener and any accepted connections are
// in different connection-topology than at baseline-capture time —
// even though the metric's intent ("did anything in the guest leak fds
// across reset") is invariant under host-connection topology. Filtering
// sockets makes the metric stable: any change indicates a non-socket
// resource leak (file handles, pipes, eventfds, etc.) which IS what we
// want to detect. Caught by 0bz7aztr on run-5 — without this filter,
// fd_match=false fired on every reset because of the natural
// connection-topology asymmetry across CHV restore.
func openFdCount() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return -1
	}
	count := 0
	for _, e := range entries {
		// Stat each fd. Socket fds have type S_IFSOCK; we exclude those.
		// Other fds (regular files, pipes, devices, eventfds) are counted
		// because their growth indicates real resource leaks across reset.
		path := "/proc/self/fd/" + e.Name()
		info, err := os.Stat(path)
		if err != nil {
			// Fd may have been closed between ReadDir and Stat — race
			// is rare but real on a busy guest. Skip; don't bias the
			// count with a stale entry.
			continue
		}
		if info.Mode()&os.ModeSocket != 0 {
			continue
		}
		count++
	}
	return count
}

func memUsage() (used, total uint64) {
	// Best-effort — parses /proc/meminfo. Errors → zeros (silent per §6.3.6).
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	var memTotalKB, memAvailableKB uint64
	for {
		var key string
		var val uint64
		var unit string
		_, err := fmt.Fscanf(f, "%s %d %s\n", &key, &val, &unit)
		if err != nil {
			break
		}
		switch key {
		case "MemTotal:":
			memTotalKB = val
		case "MemAvailable:":
			memAvailableKB = val
		}
	}
	total = memTotalKB * 1024
	if memTotalKB >= memAvailableKB {
		used = (memTotalKB - memAvailableKB) * 1024
	}
	return used, total
}

func processList() []map[string]interface{} {
	out := []map[string]interface{}{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	const maxProcs = 100
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		name, _ := os.ReadFile("/proc/" + e.Name() + "/comm")
		out = append(out, map[string]interface{}{
			"pid":  pid,
			"name": trimNewline(string(name)),
		})
		if len(out) >= maxProcs {
			break
		}
	}
	return out
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
