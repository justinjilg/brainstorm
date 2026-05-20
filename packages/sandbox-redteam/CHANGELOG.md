# @brainst0rm/sandbox-redteam

## 0.14.5

### Patch Changes

- [#343](https://github.com/justinjilg/brainstorm/pull/343) [`d0a0bda`](https://github.com/justinjilg/brainstorm/commit/d0a0bda09411fd45845b7ca912a1c214ef071a54) Thanks [@justinjilg](https://github.com/justinjilg)! - Bump every stale `0.1.0` pin on internal `@brainst0rm/*` workspace deps to `0.14.4` so they match the rest of the monorepo.

  Affected packages and their stale pins:
  - `@brainst0rm/sandbox-redteam`: `@brainst0rm/relay`, `@brainst0rm/sandbox`
  - `@brainst0rm/sandbox`: `@brainst0rm/relay`
  - `@brainst0rm/cli`: `@brainst0rm/relay` (devDeps)
  - `@brainst0rm/dispatch-sdk`: `@brainst0rm/relay`
  - `@brainst0rm/endpoint-stub`: `@brainst0rm/relay`, `@brainst0rm/sandbox`
  - `@brainst0rm/msp-executor`: `@brainst0rm/endpoint-stub`

  Pure version-string fix; no runtime change. Closes the CI breakage on `main` (build-and-test red since the workspace versions bumped past 0.1.0). Unblocks PR [#341](https://github.com/justinjilg/brainstorm/issues/341) (Stage 1 tool compiler) and PR [#342](https://github.com/justinjilg/brainstorm/issues/342) (Stage 2 contract compiler), both of which had inherited this pre-existing red check.

- Updated dependencies [[`d0a0bda`](https://github.com/justinjilg/brainstorm/commit/d0a0bda09411fd45845b7ca912a1c214ef071a54)]:
  - @brainst0rm/sandbox@0.14.5
