#!/usr/bin/env bash
# Brainstorm relay bootstrap installer.
#
# Targets: Ubuntu 22.04+, Debian 12+, x86_64.
#
# What this does:
#   1. Installs Node.js 22+ (NodeSource), build essentials, Caddy
#   2. Creates `brainstorm-relay` system user with restricted home
#   3. Clones brainstorm repo, builds @brainst0rm/relay
#   4. Generates Ed25519 tenant signing keypair + admin token + operator HMAC key
#      (UNLESS pre-existing /etc/brainstorm-relay/env is present)
#   5. Installs systemd unit + Caddyfile (TLS via Let's Encrypt)
#   6. Starts brainstorm-relay.service
#   7. Prints the operator-side connection bundle (relay URL, admin token,
#      tenant pubkey, operator HMAC key) for paste into operator config
#
# What this does NOT do:
#   - Open firewall ports (caller must allow 80/443 inbound)
#   - Configure DNS (caller must point relay.<domain> at the host first)
#   - Install Cloud Hypervisor (the relay doesn't need it; only endpoints do)
#
# Usage:
#   curl -fsSL <repo-url>/packages/relay/deploy/bootstrap.sh | sudo bash
#   OR (from a clone):
#   sudo bash packages/relay/deploy/bootstrap.sh
#
# Required env (or interactive prompts):
#   RELAY_HOSTNAME — public DNS name (e.g. relay.example.com); needed for Caddy TLS
#
# Optional env (all default-sensible):
#   BRAINSTORM_REPO_URL  — default https://github.com/justinjilg/brainstorm.git
#   BRAINSTORM_REPO_REF  — default main
#   RELAY_BIND_PORT_WS   — default 8443
#   RELAY_BIND_PORT_HTTP — default 8444
#   SKIP_CADDY=1         — if you have your own TLS termination layer

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: bootstrap must run as root (sudo)"
  exit 2
fi

if [[ -z "${RELAY_HOSTNAME:-}" ]]; then
  echo "ERROR: RELAY_HOSTNAME is required (e.g. relay.example.com)"
  echo "       set it in env or via prompt when invoking bootstrap.sh"
  exit 3
fi

REPO_URL="${BRAINSTORM_REPO_URL:-https://github.com/justinjilg/brainstorm.git}"
REPO_REF="${BRAINSTORM_REPO_REF:-main}"
WS_PORT="${RELAY_BIND_PORT_WS:-8443}"
HTTP_PORT="${RELAY_BIND_PORT_HTTP:-8444}"

INSTALL_DIR=/opt/brainstorm-relay
ETC_DIR=/etc/brainstorm-relay
DATA_DIR=/var/lib/brainstorm-relay
LOG_DIR=/var/log/brainstorm-relay
SVC_USER=brainstorm-relay
SVC_GROUP=brainstorm-relay

step() { echo; echo "== $* =="; }

step "1. Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -qq -y curl ca-certificates gnupg git build-essential jq

# Node.js 22.x via NodeSource
if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -qq -y nodejs
fi
echo "  node: $(node -v)"
echo "  npm:  $(npm -v)"

# Caddy (only if not skipped)
if [[ "${SKIP_CADDY:-0}" != "1" ]]; then
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -qq -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -qq -y caddy
  fi
  echo "  caddy: $(caddy version | head -1)"
fi

step "2. Creating service user + directories"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$INSTALL_DIR" \
          --shell /usr/sbin/nologin --user-group "$SVC_USER"
fi
mkdir -p "$ETC_DIR" "$DATA_DIR" "$LOG_DIR"
chown "$SVC_USER:$SVC_GROUP" "$DATA_DIR" "$LOG_DIR"
chmod 700 "$ETC_DIR"

step "3. Cloning + building brainstorm relay"
# Step 3 ends by `chown -R "$SVC_USER" "$INSTALL_DIR"`, so on second
# (idempotent) runs the clone is owned by brainstorm-relay while we're
# executing as root. git refuses cross-user repos by default ("dubious
# ownership"); whitelist the install dir so re-runs pick up upstream
# changes cleanly. (See issue #284.)
git config --global --add safe.directory "$INSTALL_DIR"
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  rm -rf "$INSTALL_DIR"
  git clone --depth=1 --branch="$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" fetch --depth=1 origin "$REPO_REF"
  git -C "$INSTALL_DIR" checkout "$REPO_REF"
  git -C "$INSTALL_DIR" reset --hard "origin/$REPO_REF"
fi
cd "$INSTALL_DIR"
npm install --no-audit --no-fund
npx turbo run build --filter='@brainst0rm/relay'
chown -R "$SVC_USER:$SVC_GROUP" "$INSTALL_DIR"

step "4. Provisioning secrets"
ENV_FILE="$ETC_DIR/env"
if [[ -f "$ENV_FILE" ]]; then
  echo "  $ENV_FILE already present — reusing existing secrets"
else
  ADMIN_TOKEN=$(openssl rand -hex 32)
  TENANT_KEY_HEX=$(openssl rand -hex 32)
  OPERATOR_HMAC_KEY_HEX=$(openssl rand -hex 32)

  cat > "$ENV_FILE" <<EOF
# Brainstorm relay environment
# Provisioned by bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
BRAINSTORM_RELAY_HOST=127.0.0.1
BRAINSTORM_RELAY_PORT_WS=$WS_PORT
BRAINSTORM_RELAY_PORT_HTTP=$HTTP_PORT
BRAINSTORM_RELAY_DATA_DIR=$DATA_DIR
BRAINSTORM_RELAY_ADMIN_TOKEN=$ADMIN_TOKEN
BRAINSTORM_RELAY_TENANT_KEY_HEX=$TENANT_KEY_HEX
BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX=$OPERATOR_HMAC_KEY_HEX
BRAINSTORM_RELAY_OPERATOR_ID=operator@local
BRAINSTORM_RELAY_TENANT_ID=tenant-local
EOF
  chown root:"$SVC_GROUP" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "  $ENV_FILE generated (mode 640)"
fi

step "5. Installing systemd unit"
# When this script runs via `curl ... | sudo bash`, BASH_SOURCE[0] is
# empty and dirname/cd would either fail under set -u or pick `.`. By
# step 5 the repo is always cloned at $INSTALL_DIR (step 3), so use
# the in-tree deploy dir as the canonical companion-file source.
# Fall back to BASH_SOURCE if it's set (clone-and-run invocation).
# (See issue #284.)
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$INSTALL_DIR/packages/relay/deploy"
fi
install -m 644 "$SCRIPT_DIR/relay.service" /etc/systemd/system/brainstorm-relay.service
systemctl daemon-reload

step "6. Installing Caddy config"
if [[ "${SKIP_CADDY:-0}" != "1" ]]; then
  CADDY_CFG=/etc/caddy/Caddyfile
  install -m 644 "$SCRIPT_DIR/Caddyfile.template" "$CADDY_CFG.brainstorm-tmpl"
  sed -e "s|@@RELAY_HOSTNAME@@|$RELAY_HOSTNAME|g" \
      -e "s|@@WS_PORT@@|$WS_PORT|g" \
      -e "s|@@HTTP_PORT@@|$HTTP_PORT|g" \
      "$CADDY_CFG.brainstorm-tmpl" > "$CADDY_CFG"
  systemctl reload caddy || systemctl restart caddy
  echo "  caddy reloaded with TLS for $RELAY_HOSTNAME"
fi

step "7. Starting brainstorm-relay.service"
systemctl enable brainstorm-relay.service
systemctl restart brainstorm-relay.service
sleep 2
systemctl --no-pager status brainstorm-relay.service | head -12

step "8. Connection bundle (paste into operator config)"
TENANT_PUBKEY_HEX=$(grep BRAINSTORM_RELAY_TENANT_KEY_HEX "$ENV_FILE" | cut -d= -f2 \
                   | xargs -I{} node -e "
const ed = require('$INSTALL_DIR/node_modules/@noble/ed25519');
ed.getPublicKeyAsync(Buffer.from('{}', 'hex')).then(p =>
  console.log(Buffer.from(p).toString('hex')));")

cat <<EOF

# === Brainstorm relay connection bundle ===
# Hostname:           $RELAY_HOSTNAME
# WS endpoint:        wss://$RELAY_HOSTNAME/v1/operator
# HTTP endpoint:      https://$RELAY_HOSTNAME/v1/admin/endpoint/enroll
# Admin token:        $(grep BRAINSTORM_RELAY_ADMIN_TOKEN "$ENV_FILE" | cut -d= -f2)
# Tenant pubkey hex:  $TENANT_PUBKEY_HEX
# Operator HMAC key:  $(grep BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX "$ENV_FILE" | cut -d= -f2)
# Operator id:        operator@local
# Tenant id:          tenant-local
#
# Save these values to your operator-side vault. To rotate, edit
# $ENV_FILE and 'systemctl restart brainstorm-relay'.
# ===========================================
EOF
