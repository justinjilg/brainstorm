import { defineConfig } from "tsup";

// Object-form entries remap source paths to flat output paths so the
// emitted JS lives at `dist/index.js` instead of `dist/src/index.js`.
// The flat path matches the dts output (`dist/index.d.ts`) and aligns
// with what the resolver (vite, esbuild, node) looks for when an
// `exports` field has off-axis JS — historically vite refused to
// follow `./dist/src/index.js` and the test runner crashed at module
// resolution. Keeping scripts under `dist/scripts/` matches the
// historical layout consumed by `bin/` and shell scripts.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "scripts/first-light": "scripts/first-light.ts",
    "scripts/snapshot-create": "scripts/snapshot-create.ts",
  },
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
});
