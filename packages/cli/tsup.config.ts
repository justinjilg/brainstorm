import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/bin/brainstorm.ts'],
    format: ['esm'],
    clean: true,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
  },
]);
