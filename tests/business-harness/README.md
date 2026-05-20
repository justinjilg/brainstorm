# Business Harness Live Smokes

These tests prove that `brainstorm` can operate the live Brainstorm platform
without turning normal CI into a network-dependent job.

## Gates

- No env gates: scripts print active safety state and perform no network calls.
- `RUN_LIVE_BR=1`: enables read-only calls to `api.brainstormrouter.com`.
- `RUN_LIVE_BR_WRITES=1`: reserved for future write-shaped probes and refused
  unless `BRAINSTORM_SANDBOX_TENANT_ID` is set.
- `RECORD_BR_LIVE_DISCOVERY=1`: writes a redacted JSON artifact.

`BRAINSTORM_API_KEY` is optional for read-only BR discovery. When it is missing,
the script uses the public, rate-limited community BR key already used by the
existing live contract ratchet. Community-key `429` responses are recorded as
degraded warnings; a personal or sandbox `BRAINSTORM_API_KEY` is required for a
full no-rate-limit discovery pass.

## Commands

```bash
npm run br:live-discovery
RUN_LIVE_BR=1 npm run br:live-discovery
RUN_LIVE_BR=1 RECORD_BR_LIVE_DISCOVERY=1 npm run br:live-discovery
RUN_LIVE_BR=1 RECORD_BUSINESS_HARNESS_TRACE=1 npm run br:a2a-registry
RUN_LIVE_BR=1 RECORD_BUSINESS_HARNESS_TRACE=1 npm run br:provider-envelope
RUN_LIVE_PRODUCTS=1 RECORD_PRODUCT_PLATFORM_SMOKE=1 npm run test:product-platform
npm run business:posture-trace
```

Artifact paths:

- `artifacts/br-live-discovery-summary.json`
- `artifacts/br-a2a-registry-summary.json`
- `artifacts/br-provider-envelope-summary.json`
- `artifacts/product-platform-smoke-summary.json`
- `artifacts/business-posture-trace.json`

They must never contain raw auth material or raw memory content.
