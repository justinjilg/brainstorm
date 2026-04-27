import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/canonical.ts",
    "src/signing.ts",
    "src/types.ts",
    "src/operator-key.ts",
    "src/audit.ts",
    "src/nonce-store.ts",
    "src/session-store.ts",
    "src/lifecycle.ts",
    "src/dispatch.ts",
    "src/result-router.ts",
    "src/ack-timeout.ts",
    "src/verification.ts",
    "src/relay-server.ts",
    "src/ws-binding.ts",
    "src/enrollment.ts",
    "src/bin.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
