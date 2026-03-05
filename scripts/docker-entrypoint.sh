#!/usr/bin/env bash
# Docker entrypoint: fetch secrets then exec the gateway.
set -euo pipefail

# Only fetch secrets if running on GCE (metadata server reachable)
if curl -sf --max-time 2 -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/" >/dev/null 2>&1; then
  source /app/scripts/fetch-secrets.sh
else
  echo "[entrypoint] Not on GCE — skipping secret fetch."
fi

exec "$@"
