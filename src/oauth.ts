import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { OAuthTokens } from './types.js';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function generatePkce(): PkcePair {
  // Per RFC 7636: 43-128 chars from [A-Z][a-z][0-9]-._~
  const verifier = base64UrlEncode(randomBytes(48));
  const challenge = base64UrlEncode(
    createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge, method: 'S256' };
}

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // ignore — user can copy/paste the URL
  }
}

interface CallbackResult {
  code: string;
  state: string;
}

export async function awaitAuthorizationCode(opts: {
  port: number;
  expectedState: string;
  timeoutMs: number;
}): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let resolved = false;

    const server = createServer((req, res) => {
      if (!req.url || !req.method) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${opts.port}`);
      if (url.pathname !== '/cli-callback' || req.method !== 'GET') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const body = renderResultPage(error, code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);

      if (resolved) return;
      resolved = true;

      try {
        if (error) throw new Error(`Authorization denied: ${error}`);
        if (!code) throw new Error('Missing code in callback');
        if (state !== opts.expectedState) throw new Error('State mismatch');
        resolve({ code, state });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });

    server.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        reject(new Error('Authorization timed out'));
      }
    }, opts.timeoutMs);
    timer.unref?.();

    server.listen(opts.port, '127.0.0.1');
  });
}

function renderResultPage(error: string | null, code: string | null): string {
  const ok = !error && !!code;
  const title = ok ? 'CLI authorized' : 'Authorization failed';
  const body = ok
    ? 'You can close this window and return to your terminal.'
    : `${error ?? 'Unknown error'}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0b0b0e;color:#e6e6e6}
.box{max-width:480px;padding:32px;border:1px solid #2a2a30;border-radius:12px;background:#15151a;text-align:center}
h1{margin:0 0 12px;font-size:20px}p{margin:0;color:#aaa}</style></head>
<body><div class="box"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

export interface TokenEndpointResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeCodeForTokens(opts: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokens> {
  const res = await fetch(`${opts.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'authorization_code',
      clientId: opts.clientId,
      redirectUri: opts.redirectUri,
      code: opts.code,
      codeVerifier: opts.codeVerifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as TokenEndpointResponse;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? '',
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
    clientId: opts.clientId,
  };
}

export async function refreshAccessToken(opts: {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  const res = await fetch(`${opts.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'refresh_token',
      clientId: opts.clientId,
      refreshToken: opts.refreshToken,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as TokenEndpointResponse;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? opts.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
    clientId: opts.clientId,
  };
}

export async function revokeRefreshToken(opts: {
  baseUrl: string;
  refreshToken: string;
}): Promise<void> {
  try {
    await fetch(`${opts.baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: opts.refreshToken,
        tokenTypeHint: 'refresh_token',
      }),
    });
  } catch {
    // Best-effort: server may be unreachable; logout still succeeds locally.
  }
}

/** Obtain a free localhost port for the loopback redirect server. */
export async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
