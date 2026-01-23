#!/usr/bin/env node

import { runOAuthFlow, saveTokens, getDefaultTokenPath, loadTokens } from './oauth.js';

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN_PATH || getDefaultTokenPath();

  if (!clientId || !clientSecret) {
    console.error('Error: OAuth credentials not configured.');
    console.error('');
    console.error('Please set the following environment variables:');
    console.error('  GOOGLE_OAUTH_CLIENT_ID     - Your OAuth 2.0 client ID');
    console.error('  GOOGLE_OAUTH_CLIENT_SECRET - Your OAuth 2.0 client secret');
    console.error('');
    console.error('Optional:');
    console.error('  GOOGLE_OAUTH_TOKEN_PATH    - Token file path (default: ~/.config/mcp-sheet-filler/tokens.json)');
    console.error('');
    console.error('To create OAuth credentials:');
    console.error('  1. Go to https://console.cloud.google.com/apis/credentials');
    console.error('  2. Create OAuth 2.0 Client ID (Desktop app type)');
    console.error('  3. Add http://127.0.0.1:3000/oauth2callback to authorized redirect URIs');
    process.exit(1);
  }

  // Check for existing tokens
  const existingTokens = loadTokens(tokenPath);
  if (existingTokens) {
    console.log(`Existing tokens found at: ${tokenPath}`);
    console.log('Running auth flow will replace existing tokens.\n');
  }

  console.log('Starting OAuth authentication flow...');
  console.log(`Tokens will be saved to: ${tokenPath}\n`);

  try {
    const tokens = await runOAuthFlow({
      clientId,
      clientSecret,
    });

    saveTokens(tokens, tokenPath);

    console.log('\nAuthentication successful!');
    console.log(`Tokens saved to: ${tokenPath}`);
    console.log('');
    console.log('The MCP server will now use OAuth authentication automatically.');

    if (tokens.refresh_token) {
      console.log('Refresh token obtained - tokens will auto-renew.');
    } else {
      console.log('Warning: No refresh token obtained. You may need to re-authenticate when the token expires.');
    }
  } catch (error) {
    console.error('\nAuthentication failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
