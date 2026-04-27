import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin/bsm-redteam.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Bundle the @brainst0rm/sandbox dependency into the bin so the
  // produced dist is self-contained and the CLI is runnable as
  // `node dist/bin/bsm-redteam.js` without resolving workspace symlinks
  // at runtime.
  noExternal: [/^@brainst0rm\//],
});
