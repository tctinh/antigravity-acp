import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const GOOGLE_CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface UserInfo {
  email: string;
  sub: string;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

async function startLocalServer(port: number): Promise<{
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    let codeResolver: (code: string) => void;
    const codePromise = new Promise<string>((res) => {
      codeResolver = res;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');

      if (code) {
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
        codeResolver(code);
      } else {
        res.writeHead(400);
        res.end('Missing code parameter');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({
        waitForCode: () => codePromise,
        close: () => server.close(),
      });
    });
  });
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<TokenResponse> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json() as Promise<TokenResponse>;
}

async function getUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  return response.json() as Promise<UserInfo>;
}

async function getProjectId(accessToken: string): Promise<string> {
  const response = await fetch(
    'https://cloudcode-pa.googleapis.com/v1internal/codeAssist:loadCodeAssist',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!response.ok) {
    console.error('Warning: Could not fetch project ID, using default');
    return 'default-project';
  }

  const data = (await response.json()) as { projectId?: string };
  return data.projectId || 'default-project';
}

function getConfigPath(): string {
  const configDir = process.env.ANTIGRAVITY_CONFIG
    ? path.dirname(process.env.ANTIGRAVITY_CONFIG)
    : path.join(os.homedir(), '.config', 'opencode');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  return path.join(configDir, 'antigravity.json');
}

export async function runLogin(): Promise<void> {
  console.log('Starting Google OAuth login...\n');

  const port = 8085;
  const redirectUri = `http://127.0.0.1:${port}`;
  const { codeVerifier, codeChallenge } = generatePKCE();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const server = await startLocalServer(port);

  console.log('Open this URL in your browser:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for authentication...');

  try {
    const code = await Promise.race([
      server.waitForCode(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Authentication timeout (5 minutes)')), 5 * 60 * 1000)
      ),
    ]);

    console.log('\nExchanging code for tokens...');
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri);

    console.log('Fetching user info...');
    const userInfo = await getUserInfo(tokens.access_token);
    const projectId = await getProjectId(tokens.access_token);

    const config = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      email: userInfo.email,
      projectId,
    };

    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log(`\nAuthentication successful!`);
    console.log(`  Email: ${userInfo.email}`);
    console.log(`  Project: ${projectId}`);
    console.log(`  Config saved to: ${configPath}`);
  } finally {
    server.close();
  }
}
