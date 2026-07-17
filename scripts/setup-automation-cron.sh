#!/usr/bin/env bash
#
# setup-automation-cron.sh — make Wait-step automations actually resume.
#
# A Wait step parks a run in `automation_pending_executions`; it only
# resumes when something pings GET /api/automations/cron on a schedule.
# This script wires that up on a self-hosted (EC2/VPS) box:
#
#   1. ensures AUTOMATION_CRON_SECRET exists in .env.local (generates one)
#   2. restarts the app so it picks the secret up
#   3. installs a per-minute user cron that drains due runs
#   4. verifies the endpoint answers
#
# Idempotent — safe to run again after rotating the secret or redeploying.
#
# Usage:
#   bash scripts/setup-automation-cron.sh [APP_DIR] [PUBLIC_URL]
# Defaults:
#   APP_DIR   = the repo this script lives in
#   PUBLIC_URL= https://interscalechat.co.in
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PUBLIC_URL="${2:-https://interscalechat.co.in}"
ENV_FILE="$APP_DIR/.env.local"
AUTOMATION_CRON_URL="${PUBLIC_URL%/}/api/automations/cron"
FLOW_CRON_URL="${PUBLIC_URL%/}/api/flows/cron"
MARKER="# wacrm-automation-cron"

echo "▸ App dir     : $APP_DIR"
echo "▸ Cron targets: $AUTOMATION_CRON_URL"
echo "               $FLOW_CRON_URL"

# 1) Ensure the secret exists ------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE not found. Run this from the deployed app, or pass APP_DIR." >&2
  exit 1
fi
if grep -qE '^AUTOMATION_CRON_SECRET=.+' "$ENV_FILE"; then
  echo "▸ Secret      : already set in .env.local (kept)"
else
  SECRET="$(openssl rand -hex 32)"
  printf '\n# Automation Wait-step drain cron (added by setup script)\nAUTOMATION_CRON_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
  echo "▸ Secret      : generated and appended to .env.local"
fi
SECRET="$(grep -E '^AUTOMATION_CRON_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

# 2) Restart the app so it reads the secret ----------------------------------
if command -v pm2 >/dev/null 2>&1; then
  # Restart by name if present, else restart everything pm2 knows.
  if pm2 describe wacrm >/dev/null 2>&1; then
    pm2 restart wacrm --update-env >/dev/null
    echo "▸ App         : pm2 restarted 'wacrm'"
  else
    pm2 restart all --update-env >/dev/null
    echo "▸ App         : pm2 restarted all processes"
  fi
else
  echo "▸ App         : pm2 not found — restart your app manually so it reads .env.local"
fi

# 3) Install the per-minute drain cron ---------------------------------------
if ! command -v crontab >/dev/null 2>&1; then
  echo "✗ 'crontab' not found. Install cron first:  sudo apt-get install -y cron" >&2
  exit 1
fi

# Reads the secret from .env.local at run time, so rotating it + re-running
# this script keeps the two in sync automatically.
CRON_LINE="* * * * * S=\$(grep -E '^AUTOMATION_CRON_SECRET=' \"$ENV_FILE\" | head -1 | cut -d= -f2-); [ -n \"\$S\" ] && curl -fsS -H \"x-cron-secret: \$S\" \"$AUTOMATION_CRON_URL\" >/dev/null 2>&1 && curl -fsS -H \"x-cron-secret: \$S\" \"$FLOW_CRON_URL\" >/dev/null 2>&1 $MARKER"

# Replace any prior line we installed, keep everything else. Both `crontab -l`
# (no crontab yet) and `grep -v` (empty input) legitimately exit non-zero, so
# each gets `|| true` — otherwise `set -e` kills the script silently here.
EXISTING="$(crontab -l 2>/dev/null || true)"
KEPT="$(printf '%s\n' "$EXISTING" | grep -vF "$MARKER" || true)"
printf '%s\n%s\n' "$KEPT" "$CRON_LINE" | grep -v '^[[:space:]]*$' | crontab -
echo "▸ Cron        : installed (every minute)"

# 4) Verify ------------------------------------------------------------------
# Retry, because the app is usually still booting right after the restart.
# No `-f`: we want the error body/status, not an empty string, so we can
# tell "still booting" (502/000) from a real 401/503.
echo "▸ Verifying   : calling the endpoint (waiting for the app to come up)…"
CODE="" RESP=""
for _ in 1 2 3 4 5 6 7 8; do
  OUT="$(curl -sS -m 10 -w $'\n%{http_code}' -H "x-cron-secret: $SECRET" "$AUTOMATION_CRON_URL" 2>/dev/null || true)"
  CODE="${OUT##*$'\n'}"
  RESP="${OUT%$'\n'*}"
  [ "$CODE" = "200" ] && break
  sleep 3
done
case "$CODE" in
  200) echo "✓ Working — endpoint responded: $RESP" ;;
  503) echo "✗ App isn't loading the secret (HTTP 503). Check AUTOMATION_CRON_SECRET is in .env.local, then restart the app." >&2; exit 1 ;;
  401) echo "✗ Secret mismatch (HTTP 401) between .env.local and the running app. Restart the app and re-run." >&2; exit 1 ;;
  000 | "") echo "✗ Couldn't reach $AUTOMATION_CRON_URL (no HTTP status). Is the app up and served over HTTPS?  Try: curl -I $PUBLIC_URL" >&2; exit 1 ;;
  *) echo "✗ Unexpected HTTP $CODE from $AUTOMATION_CRON_URL — body: $RESP" >&2; exit 1 ;;
esac

FLOW_OUT="$(curl -sS -m 60 -w $'\n%{http_code}' -H "x-cron-secret: $SECRET" "$FLOW_CRON_URL" 2>/dev/null || true)"
FLOW_CODE="${FLOW_OUT##*$'\n'}"
FLOW_RESP="${FLOW_OUT%$'\n'*}"
if [ "$FLOW_CODE" != "200" ]; then
  echo "✗ Flow cron verification failed (HTTP $FLOW_CODE): $FLOW_RESP" >&2
  exit 1
fi
echo "✓ Flow sweep working — endpoint responded: $FLOW_RESP"

echo
echo "Done. Wait-step automations and incomplete-flow sheets now update every minute."
echo "Watch it run:  crontab -l | grep automation-cron"
