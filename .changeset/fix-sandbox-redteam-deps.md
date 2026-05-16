---
"@brainst0rm/sandbox-redteam": patch
---

Bump internal workspace dependency versions on `@brainst0rm/relay` and `@brainst0rm/sandbox` from the stale `0.1.0` pin to `0.14.4`. The mismatch prevented npm from satisfying the deps with the local workspace packages, so the CI install copied stale dist trees that lacked the current `dist/src/index.js` entry point — every CI build of this package failed with "Could not resolve `@brainst0rm/sandbox`" since the workspace bumped past 0.1.0. Pure version-string fix, no runtime change.
