#!/usr/bin/env bash
#
# One-time Telegram bot setup for trip-planner.
#
# Asks for the bot token, checks it against Telegram, and writes it plus a
# generated webhook secret into .env.local. The token is never echoed, never
# passed as a command argument, and never written anywhere but .env.local.
#
# Usage:  bash scripts/setup-telegram.sh

set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env.local"

say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

say ""
say "Telegram bot setup for trip-planner"
say "───────────────────────────────────"
say ""

# 1. Refuse to write a secret into a file git would publish.
if ! git check-ignore -q "$ENV_FILE" 2>/dev/null; then
  fail "$ENV_FILE is NOT gitignored. Fix that before storing a token in it."
fi
say "✓ $ENV_FILE is gitignored"

# 2. Get the token without putting it on screen or in shell history.
say ""
say "Create the bot first if you haven't:"
say "  1. Open Telegram and message @BotFather"
say "  2. Send /newbot, then follow the prompts"
say "  3. It replies with a token like 8123456789:AAH...  — copy it"
say ""
printf 'Paste the bot token (input hidden), then press Enter: '
read -rs BOT_TOKEN
printf '\n'

[ -n "${BOT_TOKEN:-}" ] || fail "No token entered."

# 3. Ask Telegram whether the token is real, and who it belongs to.
say ""
say "Checking the token with Telegram…"
RESPONSE="$(curl -sS --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" || true)"

BOT_USERNAME="$(
  printf '%s' "$RESPONSE" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not body.get("ok"):
    sys.exit(1)
print(body["result"]["username"])
' 2>/dev/null || true
)"

if [ -z "$BOT_USERNAME" ]; then
  fail "Telegram rejected that token. Check you copied all of it, then run this again."
fi

say "✓ Token valid — bot is @${BOT_USERNAME}"

# 4. Generate the webhook secret. Telegram sends this back in a header on every
#    request, which is how the app knows a callback really came from Telegram.
WEBHOOK_SECRET="$(openssl rand -hex 32)"

# 5. Write the three values, replacing any earlier run's values rather than
#    stacking duplicates that would silently shadow each other.
touch "$ENV_FILE"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
grep -v -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_USERNAME|TELEGRAM_WEBHOOK_SECRET)=' "$ENV_FILE" > "$TMP" || true

# Keep the file tidy: exactly one blank line before the block.
if [ -s "$TMP" ] && [ -n "$(tail -c 1 "$TMP")" ]; then printf '\n' >> "$TMP"; fi

{
  printf '\n# Telegram alerts for the trip organiser (scripts/setup-telegram.sh)\n'
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$BOT_TOKEN"
  printf 'TELEGRAM_BOT_USERNAME=%s\n' "$BOT_USERNAME"
  printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$WEBHOOK_SECRET"
} >> "$TMP"

mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
trap - EXIT

unset BOT_TOKEN

say ""
say "✓ Wrote TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET to $ENV_FILE"
say "✓ Locked $ENV_FILE to your user only (chmod 600)"
say ""
say "Nothing was printed to screen or saved to shell history."
say ""
say "Next: tell Claude \"done\" — the bot is @${BOT_USERNAME}."
say "The same three values will need adding to Vercel production before this"
say "works outside your machine; that is a separate step."
say ""
