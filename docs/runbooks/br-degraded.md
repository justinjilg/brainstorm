# Runbook: BrainstormRouter Degraded or Unreachable

**Symptoms (any of):**

- `storm chat` hangs for >30 seconds before any response
- Chat replies with "BR returned 503" or "fetch failed: ECONNREFUSED"
- `storm doctor` shows `Models: warn` with "Reported as degraded"
- `storm router status` shows zero healthy providers
- `x-br-degradation-level` header (visible in `storm dashboard` if envelope
  panel is wired post-P1b) reports `>= 3`

## Quick verification (60s)

```bash
# 1. Is BR's public health endpoint up?
curl -sS --max-time 10 https://api.brainstormrouter.com/health
# Expected: {"status":"ok","db":true,"redis":true,"uptime":...}
# Bad:     non-200, timeout, or status != "ok"

# 2. Provider health (requires BRAINSTORM_API_KEY)
curl -sS --max-time 10 -H "Authorization: Bearer $BRAINSTORM_API_KEY" \
  https://api.brainstormrouter.com/v1/self | jq '.health.providers'
# Expected: 8 providers, all healthy
# Bad:     <8 providers OR any with status != "healthy"

# 3. Local doctor view
storm doctor
# Expected: Models section all-pass
# Bad:     any model "warn" / "fail"
```

If steps 1-2 show BR is up but the CLI still hangs, the problem is local
(network, vault, or env). Skip to "Local issues" below.

## Recovery: BR is genuinely down

You cannot fix BR from the CLI side. Options, in order:

1. **Wait.** BR's typical degradation window is < 30 min for transient
   issues. Run `curl https://api.brainstormrouter.com/health` every minute
   until status is "ok".

2. **Fall back to local models.** If you have Ollama / LM Studio running:

   ```bash
   storm models                    # Confirms local models are discovered
   storm config set router.default-strategy capability
   storm chat --model ollama:llama3.1
   ```

   The router's `capability` strategy will prefer local over BR-routed.

3. **Switch BR base URL temporarily.** If BR has a public mirror or you
   self-host a fallback gateway, point at it:

   ```bash
   export BRAINSTORM_GATEWAY_URL=https://your-fallback.example.com
   storm chat
   ```

   Unset when BR recovers (the gateway URL is sticky per shell).

## Recovery: local issues (BR is up, CLI is broken)

1. **Stale env.** A `BRAINSTORM_API_KEY` that's been revoked will show up
   here. Re-validate via:

   ```bash
   curl -sS -H "Authorization: Bearer $BRAINSTORM_API_KEY" \
     https://api.brainstormrouter.com/v1/self
   # If 401: rotate the key — see docs/runbooks/api-key-rotation.md
   ```

2. **Network egress blocked.** Some corporate networks block egress to
   api.brainstormrouter.com. Test:

   ```bash
   curl -sS -v https://api.brainstormrouter.com/health 2>&1 | head -20
   # Look for "Connected to" line — if missing, DNS or firewall is at fault
   ```

3. **Vault locked.** Even if BR is up, a locked vault prevents the CLI
   from resolving the key. See `docs/runbooks/vault-recovery.md`.

## Common failure shapes

| What you see                              | Cause                       | Fix                                            |
| ----------------------------------------- | --------------------------- | ---------------------------------------------- |
| `ECONNREFUSED` / `ENOTFOUND`              | BR DNS or net egress        | Corporate proxy or BR DNS issue                |
| HTTP 503 with body `{"error":"degraded"}` | BR is degraded but routing  | Wait; check `/v1/self.health.providers`        |
| HTTP 401 / 403                            | API key revoked or wrong    | Rotate key (api-key-rotation.md)               |
| Long hang then `AbortError`               | BR slow or upstream timeout | Check `x-br-provider-latency-ms`; switch model |
| `x-br-degradation-level: 3+` on response  | BR routing into fallback    | Tolerate; BR auto-recovers as providers heal   |

## Escalation

- If BR is verifiably down (curl step 1 fails) and you operate the BR
  side, see `docs/runbooks/startup-health.md` for the BR-side incident
  flow.
- If only YOUR account is affected (everyone else's CLI is fine),
  rotate the key and check the auth audit at
  `https://api.brainstormrouter.com/v1/governance/completion-audit?since=...`.

## What this runbook does not cover

- BR-side incident response (lives in the brainstormrouter repo).
- Multi-tenant rate-limit exhaustion (community-key DoS — separate
  runbook needed once per-host fingerprinting lands).
