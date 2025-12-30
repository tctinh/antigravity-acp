import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { StoredAccount, AntigravityConfig } from './types/index.js';

const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REDIRECT_PORT = 51121;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth-callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

const CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

const CONFIG_DIR = join(homedir(), '.config', 'opencode');
const ACCOUNTS_FILE = join(CONFIG_DIR, 'antigravity-accounts.json2');

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

export function buildAuthUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface OAuthCallback {
  code: string;
  state: string;
}

function startOAuthServer(expectedState: string): Promise<OAuthCallback> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${REDIRECT_PORT}`);

      if (url.pathname !== '/oauth-callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`OAuth Error: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400);
        res.end('Missing code or state');
        server.close();
        reject(new Error('Missing code or state'));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400);
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch - possible CSRF attack'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <div style="text-align: center;">
              <h1>Authentication Successful</h1>
              <p>You can close this tab and return to the terminal.</p>
            </div>
          </body>
        </html>
      `);

      server.close();
      resolve({ code, state });
    });

    server.listen(REDIRECT_PORT, '127.0.0.1');

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout - no callback received within 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<TokenResponse>;
}

interface UserInfo {
  email: string;
}

async function getUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }

  return response.json() as Promise<UserInfo>;
}

// Default fallback project ID (from opencode-antigravity-auth)
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

async function getProjectId(accessToken: string): Promise<string> {
  try {
    const response = await fetch(CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      console.error(`Code assist API returned ${response.status}, using default project ID`);
      return DEFAULT_PROJECT_ID;
    }

    const data = (await response.json()) as { projectId?: string; cloudaicompanionProject?: string | { id?: string } };
    
    if (data.projectId) {
      return data.projectId;
    }
    
    if (typeof data.cloudaicompanionProject === 'string') {
      return data.cloudaicompanionProject;
    }
    if (data.cloudaicompanionProject?.id) {
      return data.cloudaicompanionProject.id;
    }

    console.error('No project ID in codeAssist response, using default');
    return DEFAULT_PROJECT_ID;
  } catch (error) {
    console.error(`Failed to get project ID: ${error}, using default`);
    return DEFAULT_PROJECT_ID;
  }
}

function promptForCallbackUrl(expectedState: string): Promise<OAuthCallback> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    console.error('Paste the full callback URL from your browser (starts with http://localhost):');

    rl.question('> ', (answer) => {
      rl.close();

      try {
        const url = new URL(answer.trim());
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          reject(new Error('Invalid callback URL - missing code or state'));
          return;
        }

        if (state !== expectedState) {
          reject(new Error('State mismatch - possible CSRF attack'));
          return;
        }

        resolve({ code, state });
      } catch (e) {
        reject(new Error(`Invalid URL: ${e}`));
      }
    });
  });
}

function isWSL(): boolean {
  try {
    const release = require('node:os').release().toLowerCase();
    return release.includes('wsl') || release.includes('microsoft');
  } catch {
    return false;
  }
}

export async function authorize(manual = false): Promise<StoredAccount> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authUrl = buildAuthUrl(codeChallenge, state);
  const useManual = manual || isWSL();

  console.error('\n=== Antigravity OAuth Login ===');
  console.error('Open this URL in your browser to authenticate:');
  console.error(`\n${authUrl}\n`);

  let callback: OAuthCallback;

  if (useManual) {
    console.error('(WSL/manual mode detected - paste callback URL after authenticating)\n');
    callback = await promptForCallbackUrl(state);
  } else {
    console.error('Waiting for callback...');
    callback = await startOAuthServer(state);
  }

  console.error('\nExchanging code for tokens...');
  const tokens = await exchangeCodeForTokens(callback.code, codeVerifier);
  const userInfo = await getUserInfo(tokens.access_token);
  const projectId = await getProjectId(tokens.access_token);

  const account: StoredAccount = {
    email: userInfo.email,
    refreshToken: tokens.refresh_token,
    projectId,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  await saveAccount(account);

  console.error(`\nAuthenticated as: ${account.email}`);
  console.error(`Project ID: ${account.projectId}`);

  return account;
}

export async function loadConfig(): Promise<AntigravityConfig> {
  try {
    const content = await readFile(ACCOUNTS_FILE, 'utf-8');
    return JSON.parse(content) as AntigravityConfig;
  } catch {
    return { accounts: [] };
  }
}

export async function saveAccount(account: StoredAccount): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });

  const config = await loadConfig();
  const existingIndex = config.accounts.findIndex((a) => a.email === account.email);

  if (existingIndex >= 0) {
    config.accounts[existingIndex] = account;
  } else {
    config.accounts.push(account);
  }

  config.activeAccountIndex = existingIndex >= 0 ? existingIndex : config.accounts.length - 1;

  await writeFile(ACCOUNTS_FILE, JSON.stringify(config, null, 2));
}

export async function getActiveAccount(): Promise<StoredAccount | null> {
  const config = await loadConfig();

  if (config.accounts.length === 0) {
    return null;
  }

  const index = config.activeAccountIndex ?? 0;
  return config.accounts[index] || null;
}

export async function refreshAccessToken(account: StoredAccount): Promise<StoredAccount> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const tokens = (await response.json()) as TokenResponse;

  const updated: StoredAccount = {
    ...account,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  await saveAccount(updated);
  return updated;
}

export async function ensureValidToken(account: StoredAccount): Promise<StoredAccount> {
  const bufferMs = 5 * 60 * 1000;

  if (account.accessToken && account.expiresAt && account.expiresAt > Date.now() + bufferMs) {
    return account;
  }

  return refreshAccessToken(account);
}

export interface AuthConfig {
  accessToken: string;
  refreshToken: string;
  projectId: string;
  email?: string;
}

export async function loadAuthFromConfig(): Promise<AuthConfig | null> {
  const account = await getActiveAccount();
  if (!account) return null;

  const valid = await ensureValidToken(account);
  if (!valid.accessToken) return null;
  
  return {
    accessToken: valid.accessToken,
    refreshToken: valid.refreshToken,
    projectId: valid.projectId,
    email: valid.email,
  };
}
