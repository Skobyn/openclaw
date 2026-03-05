#!/usr/bin/env bash
# Fetch secrets from Google Secret Manager and inject into environment + config.
#
# Called by docker-entrypoint before starting the gateway.
# Requires: gcloud CLI or curl + metadata server (GCE VM / Cloud Run).
#
# Usage: source scripts/fetch-secrets.sh

set -euo pipefail

PROJECT="apex-internal-apps"

# Fetch a secret value using the GCE metadata token (no gcloud needed inside container)
fetch_secret() {
  local name="$1"
  local token
  token=$(curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

  curl -sf \
    -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access" \
    | python3 -c "import sys,json,base64; print(base64.b64decode(json.load(sys.stdin)['payload']['data']).decode(), end='')"
}

echo "[fetch-secrets] Fetching secrets from Google Secret Manager..."

export CLAWDBOT_GATEWAY_TOKEN=$(fetch_secret clawdbot-gateway-auth-token)
export GOG_KEYRING_PASSWORD=$(fetch_secret clawdbot-gog-keyring-password)
export GEMINI_API_KEY=$(fetch_secret clawdbot-gemini-api-key)

SLACK_BOT_TOKEN=$(fetch_secret clawdbot-slack-bot-token)
SLACK_APP_TOKEN=$(fetch_secret clawdbot-slack-app-token)
DISCORD_TOKEN=$(fetch_secret clawdbot-discord-token)
PERPLEXITY_API_KEY=$(fetch_secret clawdbot-perplexity-api-key)
GATEWAY_AUTH_TOKEN=$(fetch_secret clawdbot-gateway-auth-token)
HOOKS_TOKEN=$(fetch_secret clawdbot-hooks-token)

# Patch the config JSON with secret values
CONFIG_FILE="${HOME}/.openclaw/clawdbot.json"
if [ -f "$CONFIG_FILE" ]; then
  echo "[fetch-secrets] Patching config with secrets..."
  python3 -c "
import json, sys

config_path = '${CONFIG_FILE}'
with open(config_path) as f:
    cfg = json.load(f)

# Inject secrets into config
cfg.setdefault('channels', {})
if 'slack' in cfg['channels']:
    cfg['channels']['slack']['botToken'] = '${SLACK_BOT_TOKEN}'
    cfg['channels']['slack']['appToken'] = '${SLACK_APP_TOKEN}'
if 'discord' in cfg['channels']:
    cfg['channels']['discord']['token'] = '${DISCORD_TOKEN}'

cfg.setdefault('tools', {}).setdefault('web', {}).setdefault('search', {})
if 'perplexity' in cfg['tools']['web']['search']:
    cfg['tools']['web']['search']['perplexity']['apiKey'] = '${PERPLEXITY_API_KEY}'

cfg.setdefault('gateway', {}).setdefault('auth', {})
cfg['gateway']['auth']['token'] = '${GATEWAY_AUTH_TOKEN}'

cfg.setdefault('hooks', {})
cfg['hooks']['token'] = '${HOOKS_TOKEN}'

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)

print('[fetch-secrets] Config patched successfully.')
"
else
  echo "[fetch-secrets] WARNING: Config file not found at $CONFIG_FILE"
fi

echo "[fetch-secrets] Done."
