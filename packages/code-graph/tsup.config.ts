import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  sourcemap: true,
  external: [
    // Native tree-sitter bindings must not be bundled
    "tree-sitter",
    "tree-sitter-typescript",
    // Optional language grammars — loaded at runtime if installed
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-rust",
    "tree-sitter-java",
    // Native SQLite binding
    "better-sqlite3",
    // Workspace-level deps
    "zod",
    // Graph algorithms
    "graphology",
    "graphology-communities-louvain",
  ],
});
