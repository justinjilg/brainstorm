# Brainstorm relay deployment

Single-host deployment of `@brainst0rm/relay` with TLS termination via Caddy + systemd lifecycle. Targets Ubuntu 22.04+ / Debian 12+ on x86_64.

## What this deploys

- Relay binary (Node 22) running as hardened systemd service under a dedicated `brainstorm-relay` user
- Caddy as TLS-terminating reverse proxy on `:443`, auto-issuing Let's Encrypt certs
- Generated tenant signing keypair (Ed25519) + admin token + operator HMAC key, in `/etc/brainstorm-relay/env` (mode 640)
- Persistent state at `/var/lib/brainstorm-relay/`

## What this doesn't deploy

- An endpoint with a real CHV-backed executor — endpoints connect FROM other hosts
- Cloud Hypervisor itself — relay host doesn't need it
- Multi-tenant operator keys beyond the single bootstrapped tenant

## Quick start

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
sudo RELAY_HOSTNAME=relay.example.com bash packages/relay/deploy/bootstrap.sh
```

The bootstrap installs Node + Caddy, builds the relay, generates secrets, installs systemd unit + Caddyfile, starts the service, and prints the operator-side connection bundle.

## Verification

```bash
systemctl status brainstorm-relay
curl -fsS https://relay.example.com/v1/admin/endpoint/enroll \
  -X POST -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-local"}'
# → { "bootstrap_token": "...", "endpoint_id": "..." }
```

## Files

| Path                 | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `bootstrap.sh`       | Idempotent installer; safe to re-run for upgrades |
| `relay.service`      | Hardened systemd unit                             |
| `Caddyfile.template` | Caddy config with `@@`-placeholder substitution   |

## Tear-down

```bash
systemctl stop brainstorm-relay
systemctl disable brainstorm-relay
rm -f /etc/systemd/system/brainstorm-relay.service
rm -rf /etc/brainstorm-relay /var/lib/brainstorm-relay /var/log/brainstorm-relay /opt/brainstorm-relay
userdel brainstorm-relay
```

## Validation

Validated end-to-end on throwaway AWS Ubuntu 24.04 instance: install → service running → enrollment endpoint returning `bootstrap_token` over public TLS → tear-down clean.
