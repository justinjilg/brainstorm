#!/bin/bash
# Wrapper that sets vault password from 1Password and runs storm
# Usage: ./scripts/storm-run.sh [storm args...]
export BRAINSTORM_VAULT_PASSWORD="$(op read 'op://Dev Keys/Brainstorm Vault Master/password' 2>/dev/null)"
if [ -z "$BRAINSTORM_VAULT_PASSWORD" ]; then
  echo "Warning: Could not read vault password from 1Password" >&2
fi
exec storm "$@"
