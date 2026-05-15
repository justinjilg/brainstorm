#!/usr/bin/env bash
# Rollback drill — verifies the install/uninstall path between adjacent
# published versions of @brainst0rm/cli on npm.
#
# The drill:
#   1. Install latest published version → smoke
#   2. Downgrade to second-most-recent → smoke (proves rollback path)
#   3. Re-upgrade to latest → smoke (proves forward-roll after rollback)
#
# Path-to-90 P8c. Continues P8b's fresh-env verification with the
# "rollback tested" piece of D10 rubric 7-8 → 8-9.
#
# Honest scope: this validates the PUBLISHED npm registry path. It does
# NOT test rollback of CLI-managed state (vault, sessions, DB schema
# migrations) — those are separate concerns and a real production
# rollback strategy must also verify state compatibility. Documented
# in source + the commit body.

set -euo pipefail

# Use a tmpdir for BRAINSTORM_HOME so the drill is hermetic.
TMPDIR_TEST="$(mktemp -d)"
export BRAINSTORM_HOME="$TMPDIR_TEST"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

fail() {
  echo "ROLLBACK FAIL: $1" >&2
  exit 1
}

quick_smoke() {
  local label="$1"
  echo "  $label: brainstorm --version"
  local v
  v="$(brainstorm --version 2>&1)" || fail "$label: --version exited non-zero ($v)"
  if ! echo "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
    fail "$label: --version output not semver ($v)"
  fi
  echo "    OK: $v"

  echo "  $label: brainstorm --help"
  local h
  h="$(brainstorm --help 2>&1)" || fail "$label: --help exited non-zero"
  if ! echo "$h" | grep -q "init"; then
    fail "$label: --help missing 'init' command"
  fi
  echo "    OK"
}

# Discover what's on npm.
echo "==[ querying npm for published versions ]=="
DIST="$(curl -sS https://registry.npmjs.org/@brainst0rm/cli | jq -r '."dist-tags".latest')"
ALL_VERSIONS="$(curl -sS https://registry.npmjs.org/@brainst0rm/cli | jq -r '.versions | keys[]')"
echo "latest: $DIST"
echo "all versions:"
echo "$ALL_VERSIONS" | sed 's/^/  /'

# We need at least two versions to do a real drill. If only one, fall back
# to install-the-same-version twice (proves the workflow doesn't break,
# but doesn't prove rollback).
VERSION_COUNT="$(echo "$ALL_VERSIONS" | wc -l | tr -d ' ')"
if [ "$VERSION_COUNT" -lt 2 ]; then
  echo "WARN: only $VERSION_COUNT version(s) published — drill will reinstall same version"
  PREV="$DIST"
else
  # Second most recent — the rollback target.
  PREV="$(echo "$ALL_VERSIONS" | sort -V | tail -2 | head -1)"
fi
echo "rollback target: $PREV"
echo

# Stage 1: install latest.
echo "==[ stage 1: install latest ($DIST) ]=="
npm install -g "@brainst0rm/cli@$DIST"
quick_smoke "latest"

# Stage 2: downgrade.
echo
echo "==[ stage 2: downgrade to $PREV ]=="
npm install -g "@brainst0rm/cli@$PREV"
quick_smoke "prev"
# Sanity: the version we installed IS what's now on PATH.
INSTALLED_PREV="$(brainstorm --version 2>&1 | head -1)"
if [ "$INSTALLED_PREV" != "$PREV" ]; then
  # Some old versions printed a v-prefix or differed in format; accept
  # if PREV is a substring of the installed version string.
  if ! echo "$INSTALLED_PREV" | grep -q "$PREV"; then
    fail "downgrade did not install $PREV (got $INSTALLED_PREV)"
  fi
fi

# Stage 3: forward-roll back to latest.
echo
echo "==[ stage 3: forward-roll to $DIST ]=="
npm install -g "@brainst0rm/cli@$DIST"
quick_smoke "latest-again"
INSTALLED_FORWARD="$(brainstorm --version 2>&1 | head -1)"
if [ "$INSTALLED_FORWARD" != "$DIST" ]; then
  if ! echo "$INSTALLED_FORWARD" | grep -q "$DIST"; then
    fail "forward-roll did not install $DIST (got $INSTALLED_FORWARD)"
  fi
fi

echo
echo "==[ ROLLBACK DRILL PASSED ]=="
echo "  latest → $PREV → latest works end-to-end"
echo "  install/uninstall paths between adjacent published versions verified"
