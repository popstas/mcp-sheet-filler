# Blue-Green Deployment with Docker Swarm

This guide covers deploying mcp-sheet-filler in a multi-container setup with sticky sessions and zero-downtime updates.

## Problem

MCP sessions are stored **in-memory** per process (a `Map` in the HTTP transport). In a multi-container setup, a session created on container A doesn't exist on container B. Requests with an existing `mcp-session-id` must be routed back to the same container, otherwise the server returns `400 Bad Request: No active session found`.

## Solution: nginx Sticky Sessions via Consistent Hashing

nginx routes requests based on the `mcp-session-id` header:

- **New session** (no header) — route key = `$request_id` (random), distributes evenly across backends
- **Existing session** — route key = the session UUID, consistent hash always maps the same UUID to the same backend
- **Consistent hashing** (ketama) — when backends change, only ~1/N sessions remap instead of all

Reference configs are in `deploy/nginx.conf` and `deploy/docker-compose.swarm.yml`.

## Prerequisites

- Docker with Swarm mode enabled (`docker swarm init`)
- TLS certificates for your domain
- Google OAuth credentials (see [remote-http.md](remote-http.md))

## Environment Variables

Set these before deploying:

```bash
export GOOGLE_SHEET_ID=your-sheet-id
export GOOGLE_OAUTH_CLIENT_ID=your-client-id
export GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
```

## Setup

### 1. Build the Image

```bash
docker build -t mcp-sheet-filler:latest .
```

### 2. Configure nginx

Edit `deploy/nginx.conf`:

- Replace `mcp.example.com` with your domain
- Uncomment and set the `ssl_certificate` / `ssl_certificate_key` paths
- If not using Swarm DNS, replace `tasks.mcp-sheet-filler:3000` with your backend addresses:

```nginx
upstream mcp_backend {
    hash $session_route_key consistent;
    server backend1:3000;
    server backend2:3000;
}
```

### 3. Configure docker-compose

Edit `deploy/docker-compose.swarm.yml`:

- Replace `RESOURCE_URL` with your public URL
- Adjust `replicas` count as needed

### 4. Deploy the Stack

```bash
cd deploy
docker stack deploy -c docker-compose.swarm.yml mcp-filler
```

## Persistence

### Auth State (SQLite)

OAuth stores (`registeredClients`, `refreshTokens`, `pendingGoogleAuths`, `pendingAuthorizations`) are SQLite-backed. Setting `AUTH_DB_PATH=/data/auth.db` with a volume mount ensures auth state persists across container restarts.

### MCP Sessions (In-Memory)

Sessions are **not** persisted — they live in the process memory. Sticky routing ensures requests reach the correct container. If a container dies, its sessions are lost and clients must reconnect.

## Blue-Green Update Procedure

1. **Deploy green containers** alongside blue — Swarm's `order: start-first` starts new containers before stopping old ones:
   ```bash
   docker service update --image mcp-sheet-filler:v2 mcp-filler_mcp-sheet-filler
   ```

2. **Consistent hash distributes naturally** — new sessions go to both blue and green; existing sessions stay on their original backend.

3. **Mark blue as `down` in nginx** (optional, for manual control) — no new sessions routed to blue, existing SSE streams continue until they close.

4. **Monitor active sessions on blue** until they drain:
   ```bash
   curl http://blue-container:3000/health
   # Check "activeSessions": 0
   ```

5. **Remove blue** — Swarm handles this automatically with `start-first` ordering, or remove manually once drained.

## Health Check

The `/health` endpoint returns session and auth counts useful for monitoring:

```bash
curl https://mcp.example.com/health
```

```json
{
  "status": "ok",
  "instanceId": "filler-1",
  "activeSessions": 3,
  "auth": {
    "registeredClients": 5,
    "refreshTokens": 12,
    "pendingGoogleAuths": 0,
    "pendingAuthorizations": 1
  },
  "nowTs": 1739000000000,
  "rateLimit": { ... }
}
```

- `instanceId` — container hostname (`os.hostname()`), identifies which instance produced the response. In Docker Swarm with `hostname: "filler-{{.Task.Slot}}"`, this is `filler-1`, `filler-2`, etc.
- `activeSessions` — number of in-memory MCP sessions on this container. Key metric for deciding when to drain a container.
- `auth.*` — counts of OAuth-related records in SQLite.
- `nowTs` — current timestamp in epoch milliseconds, useful for detecting stale health data.
- `rateLimit` — per-user rate limit metrics from the rate limiter.

## nginx Config Details

The `deploy/nginx.conf` includes SSE-specific proxy settings for the `/mcp` endpoint:

| Setting | Value | Purpose |
|---------|-------|---------|
| `proxy_buffering` | `off` | Required for SSE streaming |
| `proxy_cache` | `off` | Prevents caching streamed responses |
| `proxy_read_timeout` | `86400s` | 24h timeout for long-lived SSE connections |
| `proxy_send_timeout` | `86400s` | 24h timeout for sending data |
| `Connection` header | `''` | Clears hop-by-hop header for HTTP/1.1 keepalive |

## Verification

After deployment, verify sticky routing works:

```bash
# 1. Initialize a session
curl -X POST https://mcp.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -v 2>&1 | grep -i mcp-session-id
# Note the mcp-session-id from the response header

# 2. Send a request with the session ID — should reach the same backend
curl -X POST https://mcp.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "mcp-session-id: <session-id-from-step-1>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Check session counts per container
curl http://container1:3000/health | jq .activeSessions
curl http://container2:3000/health | jq .activeSessions
```

## Per-Instance Metrics Collection

With multiple instances behind nginx, scraping `/health` via the public URL only hits one random instance per request. For reliable per-instance metrics (e.g. Telegraf → InfluxDB → Grafana), each instance can periodically write its health data to a JSON file on a shared volume.

### Setup

Set the `HEALTH_DIR` environment variable to enable health file writing. In Docker Swarm, the `hostname` template provides stable instance naming:

```yaml
# deploy/docker-compose.swarm.yml
hostname: "filler-{{.Task.Slot}}"
environment:
  - HEALTH_DIR=/data/health
volumes:
  - filler-data:/data
```

Each instance writes to `/data/health/{hostname}.json` every 10 seconds (atomic write via temp file + rename). On shutdown, the file is cleaned up automatically.

The `instanceId` field in the health JSON identifies which instance produced the data. The `nowTs` timestamp can be used to detect stale entries.

### Telegraf Configuration Example

```toml
[[inputs.file]]
  files = ["/path/to/filler-data/health/*.json"]
  data_format = "json"
  json_name_key = "instanceId"
  interval = "10s"
```

Stale file handling: use the `nowTs` field (epoch ms) to filter entries older than 30s in Grafana or Telegraf processors.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_DIR` | _(disabled)_ | Directory to write health JSON files. Only set in multi-instance deployments. |
| `INSTANCE_SLOT` | `os.hostname()` | Override the instance identifier used in the health filename. In Docker Swarm, `hostname` template handles this automatically. |

## Scaling

To adjust replica count:

```bash
docker service scale mcp-filler_mcp-sheet-filler=4
```

Consistent hashing minimizes session disruption — only ~1/N existing sessions remap when adding or removing a backend.
