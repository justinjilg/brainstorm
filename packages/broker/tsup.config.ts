import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/daemon.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
