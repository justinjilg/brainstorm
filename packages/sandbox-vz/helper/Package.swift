// swift-tools-version:5.9
//
// SwiftPM manifest for `bsm-vz-helper`.
//
// This is the macOS-only Swift binary that owns the Virtualization.framework
// objects on behalf of the TypeScript `VzSandbox` (see
// `packages/sandbox-vz/src/vz-sandbox.ts`). The TS side spawns this binary
// and speaks to it over NDJSON-on-stdio. The wire contract is mirrored
// from `packages/sandbox-vz/src/helper-protocol.ts` — that file is the
// source of truth; this Swift target conforms to it.
//
// Build:
//   swift build -c release
//
// After build, the helper MUST be ad-hoc-signed with the entitlements file
// before it can call VZ APIs (see helper/README.md for the exact codesign
// command). Without signing + entitlement, VZ rejects start() with
// VZErrorVirtualMachineDeniedEntitlement and the helper exits with code 64
// (HELPER_EXIT_PREFLIGHT_FAIL).
//
// Why a separate Swift package and not a workspace target?
//   The host monorepo is Node/Turborepo. Pulling Swift sources into a JS
//   workspace adds zero leverage. Keeping `helper/` as a self-contained
//   SwiftPM package means devs only need swift+xcrun on macOS, and CI
//   on Linux can ignore this directory entirely.

import PackageDescription

let package = Package(
    name: "bsm-vz-helper",
    platforms: [
        // macOS 12 is our actual deployment floor: macOS 11 is the
        // minimum that ships Virtualization.framework, but
        // VZVirtualMachine.stop(completionHandler:) is macOS 12+ only,
        // and we need it for cold-restart reset. macOS 14+ additionally
        // unlocks save/restore-state (the fast-snapshot reset path);
        // the helper auto-detects at runtime via #available.
        .macOS(.v12)
    ],
    products: [
        .executable(name: "bsm-vz-helper", targets: ["bsm-vz-helper"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "bsm-vz-helper",
            path: "Sources/bsm-vz-helper",
            // Virtualization.framework is system-provided on macOS; SwiftPM
            // picks it up via the auto-link mechanism when we `import
            // Virtualization`. No explicit linkerSettings needed.
            swiftSettings: [
                // Strict concurrency would be nice but Virtualization's
                // delegates aren't @Sendable in the SDK we ship against.
                // Leave at minimal until VZ delegates are audited.
                .unsafeFlags(["-warnings-as-errors"], .when(configuration: .release))
            ]
        ),
        .testTarget(
            name: "bsm-vz-helperTests",
            dependencies: ["bsm-vz-helper"],
            path: "Tests/bsm-vz-helperTests"
        )
    ]
)
