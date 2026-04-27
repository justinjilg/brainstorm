import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "scripts/first-light.ts",
    "scripts/snapshot-create.ts",
  ],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
});
