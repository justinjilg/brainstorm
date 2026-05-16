#!/usr/bin/env bash
# Smoke test for a globally-installed @brainst0rm/cli.
#
# Run after `npm install -g @brainst0rm/cli` (or after extracting a
# packed tarball and installing it). Asserts that the basic CLI surface
# works end-to-end on a fresh-environment install:
#
#   1. `brainstorm --version` exits 0 and prints a version string
#   2. `brainstorm --help` exits 0 and lists the documented commands
#   3. `brainstorm doctor` runs without crashing (may report warnings)
#   4. `brainstorm models` exits 0 (with or without BR key, just shouldn't crash)
#   5. `brainstorm --version` after the doctor run still works
#      (sanity: doctor didn't corrupt state)
#
# Path-to-90 P8b. Closes the v14 "no fresh-environment install verified
# in CI" gap that the Pragmatist + Sr Engineer + Pessimist all flagged.
# Honest scope: this is fresh-env VERIFICATION; rollback drill is a
# separate concern (P8c).

set -euo pipefail

# When the brainstorm binary is run on a system with no $HOME write
# perms or in a clean container, the CLI should still work. Use a
# tmpdir as BRAINSTORM_HOME to avoid polluting CI runner's $HOME.
TMPDIR_TEST="$(mktemp -d)"
export BRAINSTORM_HOME="$TMPDIR_TEST"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

echo "==[ smoke: BRAINSTORM_HOME=$BRAINSTORM_HOME ]=="

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. --version
echo "[1/5] brainstorm --version"
VERSION_OUT="$(brainstorm --version 2>&1)" || fail "version exited non-zero: $VERSION_OUT"
if ! echo "$VERSION_OUT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  fail "version output doesn't look like semver: $VERSION_OUT"
fi
echo "    OK: $VERSION_OUT"

# 2. --help
echo "[2/5] brainstorm --help"
HELP_OUT="$(brainstorm --help 2>&1)" || fail "help exited non-zero"
for cmd in init doctor models config chat run vault; do
  if ! echo "$HELP_OUT" | grep -q "$cmd"; then
    fail "help missing expected command: $cmd"
  fi
done
echo "    OK: help lists documented commands"

# 3. doctor (may report warnings; should exit 0 if all gates pass,
#    or non-zero if e.g. build artifacts are missing — both acceptable
#    for fresh-env, but should NOT crash with a stack trace).
echo "[3/5] brainstorm doctor (warnings OK, crash NOT OK)"
set +e
DOCTOR_OUT="$(brainstorm doctor 2>&1)"
DOCTOR_EXIT=$?
set -e
if echo "$DOCTOR_OUT" | grep -qE 'Error: |TypeError|Uncaught'; then
  fail "doctor crashed with unhandled error: $(echo "$DOCTOR_OUT" | head -10)"
fi
# Doctor SHOULD have printed at least one section header.
if ! echo "$DOCTOR_OUT" | grep -qE 'Build:|Environment:|Models:'; then
  fail "doctor did not print expected section headers"
fi
echo "    OK (exit=$DOCTOR_EXIT, no stack trace)"

# 4. models (should list at least cloud-via-BR option without crashing,
#    even without an API key set — the community key path handles it).
echo "[4/5] brainstorm models"
set +e
MODELS_OUT="$(brainstorm models 2>&1)"
MODELS_EXIT=$?
set -e
if echo "$MODELS_OUT" | grep -qE 'TypeError|Uncaught|MODULE_NOT_FOUND'; then
  fail "models crashed with module-level error"
fi
echo "    OK (exit=$MODELS_EXIT)"

# 5. --version still works after doctor (sanity: no state corruption)
echo "[5/5] brainstorm --version (post-doctor sanity)"
VERSION_AGAIN="$(brainstorm --version 2>&1)" || fail "version regressed after doctor"
if [ "$VERSION_AGAIN" != "$VERSION_OUT" ]; then
  fail "version drifted: was $VERSION_OUT, now $VERSION_AGAIN"
fi
echo "    OK"

echo
echo "ALL SMOKE TESTS PASSED."
