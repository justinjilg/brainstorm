import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/types.ts",
    "src/session-store.ts",
    "src/coordinator.ts",
    "src/authority.ts",
    "src/render.ts",
    "src/slack/client.ts",
    "src/slack/socket.ts",
    "src/slack/verify.ts",
    "src/slack/adapter.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
