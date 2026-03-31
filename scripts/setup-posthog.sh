#!/bin/bash
# PostHog Setup — product analytics, session replay, feature flags
#
# PostHog fills 5 gaps simultaneously:
# - Product analytics (event funnels, user paths)
# - Session replay (see what users do)
# - Feature flags (gradual rollouts)
# - A/B testing (experiment framework)
# - Surveys (in-app feedback)
#
# Free tier: 1M events/month, 5K session replays/month, unlimited feature flags
#
# Prerequisites:
# 1. Sign up at https://app.posthog.com/signup
# 2. Create project "brainstorm"
# 3. Copy the API key from Project Settings
#
# Usage: ./scripts/setup-posthog.sh <POSTHOG_API_KEY> [--project <name>]

set -euo pipefail

API_KEY="${1:-}"
PROJECT=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT="$2"; shift 2 ;;
    *) API_KEY="${API_KEY:-$1}"; shift ;;
  esac
done

if [ -z "$API_KEY" ]; then
  echo "Usage: ./scripts/setup-posthog.sh <POSTHOG_API_KEY> [--project <name>]"
  echo ""
  echo "Steps:"
  echo "  1. Go to https://app.posthog.com/signup (free tier is generous)"
  echo "  2. Create project 'brainstorm'"
  echo "  3. Copy API key from Project Settings"
  echo "  4. Run: ./scripts/setup-posthog.sh <key>"
  echo ""
  echo "Projects to install into:"
  echo "  brainstormhive  — Next.js on Vercel (primary web presence)"
  echo "  peer10          — Next.js on DO (youth sports)"
  echo "  eventflow       — Next.js on DO (event management)"
  echo "  brainstormmsp   — Next.js on DO (RMM dashboard)"
  echo ""
  echo "Or install in a specific project:"
  echo "  ./scripts/setup-posthog.sh <key> --project brainstormhive"
  exit 1
fi

# Store in 1Password
echo "Storing PostHog API key in 1Password..."
op item create \
  --vault "Dev Keys" \
  --category "API Credential" \
  --title "PostHog API Key" \
  --tags "posthog,analytics,monitoring" \
  "credential=$API_KEY" \
  "notesPlain=PostHog project API key. Used across all web apps for analytics, session replay, and feature flags." \
  2>/dev/null && echo "✓ Stored in 1Password (Dev Keys / PostHog API Key)" \
  || echo "⚠ Could not store in 1Password. Store manually."

PROJECTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/.."

# Target projects (Next.js apps that need analytics)
if [ -n "$PROJECT" ]; then
  TARGETS=("$PROJECT")
else
  TARGETS=("brainstormhive" "peer10" "eventflow" "brainstormmsp")
fi

for proj in "${TARGETS[@]}"; do
  PROJ_DIR="$PROJECTS_DIR/$proj"

  if [ ! -d "$PROJ_DIR" ]; then
    echo "⚠ Skipping $proj — directory not found"
    continue
  fi

  echo ""
  echo "Setting up PostHog in $proj..."

  # Check if it's a Next.js project
  if [ -f "$PROJ_DIR/package.json" ]; then
    cd "$PROJ_DIR"

    # Install posthog-js
    if grep -q "posthog-js" package.json 2>/dev/null; then
      echo "  [skip] posthog-js already installed"
    else
      echo "  Installing posthog-js..."
      npm install posthog-js 2>/dev/null || echo "  ⚠ npm install failed — install manually"
    fi

    # Create PostHog provider component
    PROVIDER_DIR=""
    if [ -d "src/app" ]; then
      PROVIDER_DIR="src/app"
    elif [ -d "app" ]; then
      PROVIDER_DIR="app"
    elif [ -d "apps/web/src/app" ]; then
      PROVIDER_DIR="apps/web/src/app"
    elif [ -d "apps/web/app" ]; then
      PROVIDER_DIR="apps/web/app"
    fi

    if [ -n "$PROVIDER_DIR" ] && [ ! -f "$PROVIDER_DIR/posthog-provider.tsx" ]; then
      echo "  Creating PostHog provider at $PROVIDER_DIR/posthog-provider.tsx"
      cat > "$PROVIDER_DIR/posthog-provider.tsx" << 'EOF'
'use client'

import posthog from 'posthog-js'
import { PostHogProvider as PHProvider } from 'posthog-js/react'
import { useEffect } from 'react'

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
      posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
        person_profiles: 'identified_only',
        capture_pageview: true,
        capture_pageleave: true,
        // Session replay (free tier: 5K/month)
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: '[data-mask]',
        },
      })
    }
  }, [])

  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return <>{children}</>

  return <PHProvider client={posthog}>{children}</PHProvider>
}
EOF
      echo "  ✓ Provider created"
    else
      echo "  [skip] Provider already exists or no app dir found"
    fi

    echo "  ✓ $proj ready — add <PostHogProvider> to root layout"
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "PostHog setup complete!"
echo ""
echo "Next steps for each project:"
echo "  1. Add env var: NEXT_PUBLIC_POSTHOG_KEY=$API_KEY"
echo "  2. Wrap root layout children with <PostHogProvider>"
echo "  3. Deploy and verify events at https://app.posthog.com"
echo ""
echo "Enable features in PostHog dashboard:"
echo "  - Session Replay: already configured in provider"
echo "  - Feature Flags: create flags at app.posthog.com/feature_flags"
echo "  - Surveys: create at app.posthog.com/surveys"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
