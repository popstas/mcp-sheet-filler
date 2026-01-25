# Remote HTTP Deployment Guide

This guide covers deploying the MCP Sheet Filler server in HTTP mode and connecting to it from various clients.

## Prerequisites

1. **Google OAuth Credentials** - Create OAuth 2.0 credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. **Public URL** - Your server must be accessible from the internet (use a cloud provider or tunnel service like ngrok)
3. **Environment Variables**:
   ```bash
   RESOURCE_URL=https://your-server.com      # Public URL of your server
   GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=xxx
   GOOGLE_SHEET_ID=xxx                        # Your Google Sheet ID
   TRANSPORT=http
   ```

## Starting the Server

```bash
# Development
RESOURCE_URL=https://your-server.com TRANSPORT=http npm run dev

# Production
RESOURCE_URL=https://your-server.com TRANSPORT=http npm start

# Docker
docker run -p 3000:3000 \
  -e RESOURCE_URL=https://your-server.com \
  -e GOOGLE_SHEET_ID=your-sheet-id \
  -e GOOGLE_OAUTH_CLIENT_ID=your-client-id \
  -e GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret \
  mcp-sheet-filler
```

## Verify Server is Running

```bash
# Health check (no auth required)
curl https://your-server.com/health
# Returns: {"status":"ok"}

# Protected Resource Metadata (no auth required)
curl https://your-server.com/.well-known/oauth-protected-resource
# Returns: {"resource":"https://your-server.com","authorization_servers":["https://accounts.google.com"],"bearer_methods_supported":["header"]}
```

---

## 1. Testing with MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is an interactive browser-based tool for testing MCP servers.

### Install and Run

```bash
npx @modelcontextprotocol/inspector
```

This opens a web UI at `http://localhost:6274`.

### Connect to Your Server

1. In the Inspector UI, select **"Streamable HTTP"** transport
2. Enter your server URL: `https://your-server.com/mcp`
3. Add authentication header:
   - Header name: `Authorization`
   - Header value: `Bearer <your-google-access-token>`

### Getting a Google Access Token for Testing

You can obtain a test access token using the OAuth Playground:

1. Go to [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (⚙️) and check "Use your own OAuth credentials"
3. Enter your OAuth client ID and secret
4. Select scopes (all three required):
   - `openid` (for user identification)
   - `email` (for user email)
   - `https://www.googleapis.com/auth/spreadsheets` (for Sheets access)
5. Click "Authorize APIs" and complete the flow
6. Click "Exchange authorization code for tokens"
7. Copy the `access_token` from the response

**Note:** This token serves dual purpose - it authenticates you to the MCP server AND grants access to Google Sheets. No separate `filler_google_auth` step needed.

**Important:** The `openid` and `email` scopes are required for user identification. Without them, the server cannot determine who is making the request.

### Testing Tools

Once connected, you can:
- List available tools
- Call `filler_list_fields` to see your schema
- Call `filler_get_object_by_name` to retrieve data
- Test `filler_save_object_no_overwrite` to save data

---

## 2. Connecting to Claude Desktop

Claude Desktop supports remote MCP servers on Pro, Max, Team, and Enterprise plans.

### Option A: Via Settings UI (Recommended)

1. Open Claude Desktop
2. Go to **Settings** → **Connectors**
3. Click **"Add custom connector"**
4. Enter your server URL: `https://your-server.com/mcp`
5. Configure authentication (see below)

### Option B: Using mcp-remote

If direct URL configuration isn't available, use the `mcp-remote` package.

Edit your Claude Desktop config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sheet-filler": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-server.com/mcp",
        "--header",
        "Authorization: Bearer <your-google-access-token>"
      ]
    }
  }
}
```

### Authentication Notes

The server implements the [MCP Authorization specification (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728). Claude Desktop supports:

- **OAuth with Dynamic Client Registration (DCR)** - If your Google OAuth app supports DCR
- **Custom OAuth credentials** - Using Claude's callback URL: `https://claude.ai/api/mcp/auth_callback`
- **Bearer tokens** - Static access tokens (requires manual refresh)

For production use, implement OAuth with refresh token support in your client application.

---

## 3. Connecting to ChatGPT

ChatGPT supports MCP servers through the Connectors feature, available on Pro, Team, Enterprise, and Edu plans.

### Enable Developer Mode

1. Open ChatGPT Settings
2. Navigate to **Connectors** → **Advanced**
3. Enable **Developer Mode**

> **Note**: Developer Mode allows connecting to any MCP server. Without it, servers must implement `search` and `fetch` tools.

### Add MCP Connector

1. In ChatGPT, go to **Settings** → **Connectors**
2. Click **"Add connector"** or **"+"**
3. Select **"Custom MCP server"** or **"Developer Mode"**
4. Enter your server URL: `https://your-server.com/mcp`
5. Configure authentication:
   - Select **"Bearer token"** or **"OAuth"**
   - Enter your Google access token

### Important Limitations

- **Remote only**: ChatGPT cannot connect to localhost. Use a tunnel (ngrok, cloudflared) or deploy to a cloud provider.
- **Streamable HTTP required**: The server must support Streamable HTTP transport (this server does).
- **Write operations warning**: ChatGPT may warn about "dangerous" operations. The `save_object_no_overwrite` tool only modifies empty fields.

### Using with Deep Research

ChatGPT Deep Research can use MCP servers to fetch data. Your server's tools will be available as data sources during research tasks.

---

## Authentication Options

### Unified Auth (Recommended)

The MCP access token is automatically reused for Google Sheets API access. This means:
- **One auth, two purposes** - no separate `filler_google_auth` needed
- Client obtains a Google OAuth token with required scopes
- Same token authenticates to MCP server AND accesses Google Sheets

**Required scopes:**
- `openid` - for user identification
- `email` - for user email (recommended)
- `https://www.googleapis.com/auth/spreadsheets` - for Sheets access

**Requirements:**
- Token must include all required scopes listed above
- Token must be issued for the same OAuth client ID as the server

### Alternative: Separate Sheets Auth

If your MCP token doesn't include the Sheets scope, use `filler_google_auth`:

1. Call `filler_google_auth` with `action: "start_auth"`
2. Visit the verification URL and enter the code
3. Call `filler_google_auth` with `action: "complete_auth"` and the `device_code`

Tokens are stored per-user and auto-refresh.

### Service Account (No User Auth)

For automated/server-to-server use, use a Google service account:

1. Create a service account in Google Cloud Console
2. Download the JSON key
3. Share your Google Sheet with the service account email
4. Set `GOOGLE_SERVICE_ACCOUNT_KEY` environment variable

```bash
GOOGLE_SERVICE_ACCOUNT_KEY=/path/to/service-account.json npm start
```

---

## Security Considerations

1. **Token validation**: All requests to `/mcp` are validated against Google's tokeninfo endpoint
2. **Audience check**: Tokens must be issued for your OAuth client ID
3. **HTTPS required**: Always use HTTPS in production
4. **Token exposure**: Never commit tokens to version control
5. **Per-user isolation**: Each authenticated user has separate Google Sheets token storage

## Troubleshooting

### 401 Unauthorized

Check the `WWW-Authenticate` header in the response:
```bash
curl -v https://your-server.com/mcp
```

Common issues:
- Missing or malformed `Authorization` header
- Expired access token
- Token issued for different OAuth client ID

### Connection Refused

- Verify the server is running: `curl https://your-server.com/health`
- Check firewall/security group rules
- Ensure RESOURCE_URL matches your actual public URL

### "Token not issued for this resource"

The access token's audience (aud) doesn't match your `GOOGLE_OAUTH_CLIENT_ID`. Ensure you're obtaining tokens using the same OAuth app credentials.

---

## References

- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [Claude Remote MCP Servers](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
- [OpenAI MCP Connectors](https://platform.openai.com/docs/guides/tools-connectors-mcp)
- [RFC 9728 - OAuth Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
