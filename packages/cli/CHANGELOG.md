# @brainst0rm/cli

## 0.15.0

### Minor Changes

- [#354](https://github.com/justinjilg/brainstorm/pull/354) [`63f30ca`](https://github.com/justinjilg/brainstorm/commit/63f30cab8d818a02eff7c8fc42a3abc5fa81658a) Thanks [@justinjilg](https://github.com/justinjilg)! - Add `brainstorm a2a list` — lists capabilities published to the Agent Capability Registry on VM CP. Supports `--product`, `--status`, `--vm-url`, `--token`, `--json` flags. Closes plan §P5 M7 dependency on CLI capability discovery.

- [#355](https://github.com/justinjilg/brainstorm/pull/355) [`14169fc`](https://github.com/justinjilg/brainstorm/commit/14169fcfaab1e588f02725c8c52a78efbbdd1b10) Thanks [@justinjilg](https://github.com/justinjilg)! - Add `brainstorm login` — OAuth 2.0 Device Authorization Grant (RFC 8628) against the Brainstorm platform Keycloak at `auth.brainstorm.co`. Persists session token at `~/.brainstorm/session` (chmod 600). Implements v0.3 P1.5 / M4 / D12 of radiant-petting-kitten.

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
