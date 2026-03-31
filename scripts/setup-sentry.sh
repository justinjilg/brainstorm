#!/bin/bash
# Sentry Setup Script
# Run after creating a Sentry account at https://sentry.io
#
# Prerequisites:
# 1. Sign up at https://sentry.io (free tier: 5K errors/month)
# 2. Create org "brainstorm" and project "brainstorm-cli" (Node.js platform)
# 3. Copy the DSN from Settings → Projects → brainstorm-cli → Client Keys (DSN)
# 4. Run: ./scripts/setup-sentry.sh <DSN>

set -euo pipefail

DSN="${1:-}"

if [ -z "$DSN" ]; then
  echo "Usage: ./scripts/setup-sentry.sh <SENTRY_DSN>"
  echo ""
  echo "Steps:"
  echo "  1. Go to https://sentry.io/signup/"
  echo "  2. Create org: brainstorm"
  echo "  3. Create project: brainstorm-cli (platform: Node.js)"
  echo "  4. Copy the DSN from project settings"
  echo "  5. Re-run this script with the DSN"
  exit 1
fi

# Validate DSN format
if [[ ! "$DSN" =~ ^https://[a-f0-9]+@[a-z0-9.]+/[0-9]+$ ]]; then
  echo "Error: Invalid DSN format. Expected: https://<key>@<host>/<project-id>"
  exit 1
fi

echo "Storing Sentry DSN in 1Password Dev Keys vault..."

# Store in 1Password
op item create \
  --vault "Dev Keys" \
  --category "API Credential" \
  --title "Sentry DSN" \
  --tags "sentry,monitoring,brainstorm" \
  "credential=$DSN" \
  "notesPlain=Sentry DSN for brainstorm-cli error tracking. Used by @brainst0rm/shared sentry.ts module." \
  2>/dev/null

if [ $? -eq 0 ]; then
  echo "✓ Stored in 1Password (Dev Keys / Sentry DSN)"
else
  echo "Error storing in 1Password. Store manually:"
  echo "  Vault: Dev Keys"
  echo "  Title: Sentry DSN"
  echo "  Credential: $DSN"
fi

# Verify it works
echo ""
echo "Testing Sentry connection..."
node -e "
const Sentry = require('@sentry/node');
Sentry.init({ dsn: '$DSN', tracesSampleRate: 0 });
Sentry.captureMessage('Brainstorm Sentry setup test', 'info');
Sentry.flush(2000).then(() => console.log('✓ Test event sent to Sentry'));
" 2>/dev/null || echo "Note: Run from brainstorm repo root after 'npm install'"

echo ""
echo "Setup complete! To activate Sentry:"
echo "  export SENTRY_DSN=\$(op read 'op://Dev Keys/Sentry DSN/credential')"
echo ""
echo "Or add to ~/.zshrc:"
echo "  export SENTRY_DSN=\$(op read 'op://Dev Keys/Sentry DSN/credential')"
