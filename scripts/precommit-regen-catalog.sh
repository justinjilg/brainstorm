#!/usr/bin/env bash
# Pre-commit hook helper — invoked by lint-staged when files matching
# packages/tools/src/builtin/**/*.ts are staged. Regenerates the exported
# tool catalog and stages it alongside the source change so the CI
# freshness check (`packages/tools` → `export-catalog:check`) can't fail
# on a forgotten regen.
#
# lint-staged appends the matched file paths as args; we ignore them
# because the export script reads the registry, not those files.
set -euo pipefail
cd "$(dirname "$0")/.."
npm --prefix packages/tools run --silent export-catalog >/dev/null
git add docs/tool-catalog.json
