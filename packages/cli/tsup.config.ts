import { defineConfig } from "tsup";

// Native-module wrappers stay external so esbuild doesn't try to bundle
// their .node files. tree-sitter + tree-sitter-typescript are published
// to npm; better-sqlite3 likewise. @brainst0rm/code-graph WRAPS
// tree-sitter — its JS gets bundled (via noExternal below) but the
// underlying .node files reach the user via npm-resolved tree-sitter.
const externals = ["tree-sitter", "tree-sitter-typescript", "better-sqlite3"];

// Bundle ALL @brainst0rm/* workspace packages into the CLI dist so the
// published tarball doesn't reference them as npm-registry deps. v15
// Auditor + fresh-install CI (gh run 25947493817) caught that workspace
// packages aren't published to npm — they live only in this monorepo.
// Bundling is the right answer for a CLI: operators run
// `npm install -g @brainst0rm/cli` and get a self-contained binary, not
// a dep tree requiring every internal package on the public registry.
//
// Third-party deps (react, ink, chalk, commander, native modules above)
// stay external so npm resolves them at install time — they ARE on the
// registry. P8b workflow validates the contract on every relevant PR.
const noExternal = [/^@brainst0rm\//];

export default defineConfig([
  {
    entry: ["src/bin/brainstorm.ts"],
    format: ["esm"],
    clean: true,
    sourcemap: true,
    external: externals,
    noExternal,
    // Bundled workspace code uses CJS-style require() in places. Without
    // this shim, an ESM bundle hits "Dynamic require of X is not supported"
    // at runtime. createRequire(import.meta.url) gives the bundled code a
    // working require() bound to the current module URL — the standard
    // ESM-CJS interop shim. (P8b CI surfaced this on smoke after the
    // initial install succeeded.)
    banner: {
      js: `#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
    },
  },
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    external: externals,
    noExternal,
  },
]);
