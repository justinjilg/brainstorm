#!/bin/bash
#
# Brainstorm Dogfood Session — first autonomous run on itself
#
# Prerequisites:
#   1. source ~/.zshrc (loads API keys from 1Password)
#   2. npm install && npx turbo run build
#
# This script:
#   1. Runs full onboard (with LLM) to build project memory
#   2. Verifies memory entries were created
#   3. Starts a KAIROS daemon session with a real task
#   4. Records all output to docs/dogfood/
#
# Usage: ./scripts/dogfood.sh
#

set -euo pipefail

BRAINSTORM="node packages/cli/dist/brainstorm.js"
DOGFOOD_DIR="docs/dogfood"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SESSION_LOG="$DOGFOOD_DIR/session-$TIMESTAMP.log"

echo "════════════════════════════════════════════════"
echo "  Brainstorm Dogfood Session"
echo "  $(date)"
echo "════════════════════════════════════════════════"
echo ""

# Check API keys
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY not set."
  echo "Run: source ~/.zshrc"
  exit 1
fi

echo "✓ API keys available"

# Create output directory
mkdir -p "$DOGFOOD_DIR"

# Step 1: Full onboard (with LLM)
echo ""
echo "Step 1: Onboarding brainstorm on itself..."
echo "─────────────────────────────────────────"
$BRAINSTORM onboard . --budget 3.00 2>&1 | tee "$DOGFOOD_DIR/onboard-$TIMESTAMP.log"

# Step 2: Verify memory
echo ""
echo "Step 2: Verifying memory entries..."
echo "─────────────────────────────────────────"
$BRAINSTORM memory list 2>&1 | tee "$DOGFOOD_DIR/memory-$TIMESTAMP.log"
MEMORY_COUNT=$($BRAINSTORM memory list 2>&1 | grep -c "│" || echo "0")
echo "Memory entries found: $MEMORY_COUNT"

if [ "$MEMORY_COUNT" -lt 3 ]; then
  echo "WARNING: Expected 5+ memory entries from onboard. Got $MEMORY_COUNT."
  echo "The onboard → memory bridge may not be working."
fi

# Step 3: Run brainstorm models to verify providers
echo ""
echo "Step 3: Checking available models..."
echo "─────────────────────────────────────────"
$BRAINSTORM models 2>&1 | head -20 | tee "$DOGFOOD_DIR/models-$TIMESTAMP.log"

# Step 4: Run a single non-interactive task
echo ""
echo "Step 4: Running a single task (non-daemon)..."
echo "─────────────────────────────────────────"
echo "Task: 'List the 5 packages with lowest test coverage and suggest what to test first.'"
$BRAINSTORM run "List the 5 packages in this monorepo with the lowest test coverage ratio (test lines / source lines). For each, suggest the single most valuable test to add first. Be specific — name the function and the test case." 2>&1 | tee "$DOGFOOD_DIR/task-$TIMESTAMP.log"

echo ""
echo "════════════════════════════════════════════════"
echo "  Dogfood Session Complete"
echo "  Logs: $DOGFOOD_DIR/"
echo "════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Review the logs above"
echo "  2. If step 1-4 worked, try the daemon:"
echo "     $BRAINSTORM chat --daemon"
echo "     Then type: 'add tests to the 3 packages with lowest coverage'"
echo "  3. Let KAIROS run for 10-30 minutes"
echo "  4. Commit the session logs: git add docs/dogfood/ && git commit -m 'dogfood: first autonomous session'"
