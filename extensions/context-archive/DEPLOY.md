# Context Archive Plugin — Deployment Guide

## Prerequisites

- GCE VM running Clawdbot Gateway via Docker (per the main deployment guide)
- A Gemini API key (free tier works) from [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)

## 1. SSH into Your VM

```bash
gcloud compute ssh --zone "us-central1-b" "scott-clawdbot" --project "apex-internal-apps"
```

## 2. Pull the Updated Source and Rebuild

```bash
cd ~/clawdbot
git pull
docker compose build
```

## 3. Add the API Key to Your Environment

Add to your existing `.env` on the VM:

```bash
echo 'GEMINI_API_KEY=AIza...' >> .env
```

Then add it to the `environment` section of `docker-compose.yml`:

```yaml
environment:
  - GEMINI_API_KEY=${GEMINI_API_KEY}
```

## 4. Configure the Plugin

Edit the openclaw config file inside the persistent volume:

```bash
nano ~/.clawdbot/openclaw.json
```

Add the plugin configuration under the `plugins` key:

```json
{
  "plugins": {
    "slots": {
      "memory": "context-archive"
    },
    "entries": {
      "context-archive": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "gemini",
            "apiKey": "${GEMINI_API_KEY}",
            "model": "gemini-embedding-001"
          },
          "autoInject": true,
          "maxInjectChunks": 3,
          "chunkTokens": 512
        }
      }
    }
  }
}
```

If you already have other config in `openclaw.json`, merge the `plugins` section into it.

> **Note:** If you also want to keep `memory-lancedb` running alongside, don't set
> `slots.memory` — both plugins can coexist since context-archive uses
> `before_compaction`/`before_reset` hooks rather than competing for the memory slot.

## 5. Restart

```bash
docker compose up -d
```

## 6. Verify

Check the logs:

```bash
docker compose logs -f clawdbot-gateway | grep context-archive
```

Expected output:

```
context-archive: plugin registered (db: /home/node/.openclaw/context-archive/archive.db, lazy init)
context-archive: initialized (db: ..., model: gemini-embedding-001, vec: true/false, autoInject: true)
```

After a conversation triggers compaction you will see:

```
context-archive: archived N chunks for session abc123...
```

## 7. Test Retrieval

Once some context has been archived, the agent can use the `context_recall` tool automatically. You can also test via CLI:

```bash
docker compose exec clawdbot-gateway node dist/index.js archive stats
docker compose exec clawdbot-gateway node dist/index.js archive search "your query"
```

## Safety Notes

- The plugin **never blocks compaction** — all errors are caught and logged.
- The SQLite DB is stored at `~/.clawdbot/context-archive/archive.db` inside the persistent volume, so it survives container restarts.
- `${GEMINI_API_KEY}` in the config is resolved at runtime from the environment variable — the actual key is never written to the config file.
- If `sqlite-vec` isn't available in the container, search falls back to FTS-only (keyword matching).

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `embedding.provider` | `gemini` | `gemini` or `openai` |
| `embedding.apiKey` | *(required)* | API key or `${ENV_VAR}` reference |
| `embedding.model` | `gemini-embedding-001` | Embedding model name |
| `embedding.baseUrl` | *(auto)* | Custom API base URL |
| `embedding.dimensions` | *(auto)* | Vector dimensions (768 for Gemini, 1536 for OpenAI) |
| `dbPath` | `~/.openclaw/context-archive/archive.db` | SQLite database path |
| `autoInject` | `true` | Auto-inject relevant archived context before agent starts |
| `maxInjectChunks` | `3` | Max chunks to auto-inject per prompt |
| `chunkTokens` | `512` | Target token count per archived chunk |
| `consolidateAfter` | `50` | Unconsolidated chunk count before triggering consolidation |
