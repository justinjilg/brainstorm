import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/connectors/agent/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
