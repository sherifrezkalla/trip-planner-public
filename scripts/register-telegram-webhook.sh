#!/usr/bin/env bash
#
# Point the Telegram bot at the deployed webhook.
#
# Run this once after the Telegram alert code is live in production. Telegram
# will not deliver anything until it knows where to send it, and it only accepts
# an HTTPS URL — which is why this cannot be done against localhost.
#
# Reads credentials from .env.local. Nothing is printed.
#
# Usage:  bash scripts/register-telegram-webhook.sh <https-webhook-url>
#         requires the URL for your own installation

set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env.local"
WEBHOOK_URL="${1:-}"

say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

[ -n "$WEBHOOK_URL" ] || fail "Supply your own HTTPS webhook URL as the first argument. No default host is configured."

read_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }

[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found. Run scripts/setup-telegram.sh first."

BOT_TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
WEBHOOK_SECRET="$(read_env TELEGRAM_WEBHOOK_SECRET)"

[ -n "$BOT_TOKEN" ] || fail "TELEGRAM_BOT_TOKEN missing. Run scripts/setup-telegram.sh."
[ -n "$WEBHOOK_SECRET" ] || fail "TELEGRAM_WEBHOOK_SECRET missing. Run scripts/setup-telegram.sh."

case "$WEBHOOK_URL" in
  https://*) ;;
  *) fail "Telegram only accepts HTTPS. Got: $WEBHOOK_URL" ;;
esac

say ""
say "Pointing the bot at:"
say "  $WEBHOOK_URL"
say ""

RESPONSE="$(
  curl -sS --max-time 20 \
    --data-urlencode "url=${WEBHOOK_URL}" \
    --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message","callback_query"]' \
    --data-urlencode 'drop_pending_updates=true' \
    "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" || true
)"

printf '%s' "$RESPONSE" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    print("✗ Telegram returned something unreadable."); sys.exit(1)
if not body.get("ok"):
    print("✗ Telegram refused: " + str(body.get("description"))); sys.exit(1)
print("✓ Webhook registered")
' || fail "Registration failed."

# Confirm from Telegram's side rather than trusting the write.
INFO="$(curl -sS --max-time 20 "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" || true)"
printf '%s' "$INFO" | python3 -c '
import json, sys
body = json.load(sys.stdin)
r = body.get("result", {})
print("  url:              " + str(r.get("url")))
print("  custom secret:    " + ("yes" if r.get("has_custom_certificate") is not None else "unknown"))
print("  pending updates:  " + str(r.get("pending_update_count")))
if r.get("last_error_message"):
    print("  ⚠ last error:     " + str(r.get("last_error_message")))
' 2>/dev/null || true

unset BOT_TOKEN WEBHOOK_SECRET

say ""
say "Next: open the trip as organiser, tap 🔔 Get Telegram alerts, and follow"
say "the link. The bot should reply confirming which trip it is linked to."
say ""
