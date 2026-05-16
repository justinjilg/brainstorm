---
"@brainst0rm/sandbox-redteam": patch
"@brainst0rm/sandbox": patch
"@brainst0rm/cli": patch
"@brainst0rm/dispatch-sdk": patch
"@brainst0rm/endpoint-stub": patch
"@brainst0rm/msp-executor": patch
---

Bump every stale `0.1.0` pin on internal `@brainst0rm/*` workspace deps to `0.14.4` so they match the rest of the monorepo.

Affected packages and their stale pins:

- `@brainst0rm/sandbox-redteam`: `@brainst0rm/relay`, `@brainst0rm/sandbox`
- `@brainst0rm/sandbox`: `@brainst0rm/relay`
- `@brainst0rm/cli`: `@brainst0rm/relay` (devDeps)
- `@brainst0rm/dispatch-sdk`: `@brainst0rm/relay`
- `@brainst0rm/endpoint-stub`: `@brainst0rm/relay`, `@brainst0rm/sandbox`
- `@brainst0rm/msp-executor`: `@brainst0rm/endpoint-stub`

Pure version-string fix; no runtime change. Closes the CI breakage on `main` (build-and-test red since the workspace versions bumped past 0.1.0). Unblocks PR #341 (Stage 1 tool compiler) and PR #342 (Stage 2 contract compiler), both of which had inherited this pre-existing red check.
