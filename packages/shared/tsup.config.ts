import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/features-build.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
