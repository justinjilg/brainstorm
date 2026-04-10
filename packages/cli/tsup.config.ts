import { defineConfig } from "tsup";

// Native modules (tree-sitter, better-sqlite3) must be external to avoid
// esbuild trying to bundle their .node files.
const externals = [
  "@brainst0rm/code-graph",
  "tree-sitter",
  "tree-sitter-typescript",
  "better-sqlite3",
];

export default defineConfig([
  {
    entry: ["src/bin/brainstorm.ts"],
    format: ["esm"],
    clean: true,
    sourcemap: true,
    external: externals,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    external: externals,
  },
]);
