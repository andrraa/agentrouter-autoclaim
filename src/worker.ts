import { launch, type BrowserWorker } from '@cloudflare/playwright';

interface Env { DB: D1Database; ASSETS: Fetcher; BROWSER: BrowserWorker; ACCESS_CODE: string; ENCRYPTION_KEY: string }
type Account = { id: number; label: string; github_cookie: string; enabled: number };
const BASE = 'https://agentrouter.org';
const CLIENT_ID = 'Ov23lidtiR4LeVZvVRNL';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36';
const json = (data: unknown, status = 200) => Response.json(data, { status });

async function key(env: Env) {
  const raw = Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(value: string, env: Env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...iv, ...encrypted));
}
async function decrypt(value: string, env: Env) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(env), bytes.slice(12)));
}
function sessionUserId(value: string) {
  try {
    const decode = (input: string) => atob(input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '='));
    const parts = decode(decodeURIComponent(value)).split('|');
    return decode(parts[1]).match(/github_(\d+)/)?.[1];
  } catch { return undefined; }
}
function githubCookies(header: string) {
  return header.replace(/[\r\n\t]+/g, ' ').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf('=');
    return { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim(), domain: '.github.com', path: '/' };
  }).filter((cookie) => cookie.name && cookie.value);
}
async function oauthState() {
  const response = await fetch(`${BASE}/api/oauth/state`, { headers: { accept: 'application/json', origin: BASE, referer: `${BASE}/login`, 'user-agent': USER_AGENT } });
  const body = await response.json<{ success?: boolean; data?: string }>();
  if (!body.success || !body.data) throw new Error('Failed to get OAuth state');
  return body.data;
}
async function readSelf(page: import('@cloudflare/playwright').Page) {
  await page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(5_000);
  const inPage = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    return response.json().catch(() => null);
  }, `${BASE}/api/user/self`).catch(() => null) as { success?: boolean; data?: unknown } | null;
  if (inPage?.success && inPage.data) return inPage.data;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await page.goto(`${BASE}/api/user/self`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const text = await response?.text() || '';
    try { const body = JSON.parse(text); if (body.success && body.data) return body.data; } catch { /* WAF HTML */ }
    await page.waitForTimeout(4_000);
  }
  throw new Error('AgentRouter self API was blocked by the WAF');
}
async function claim(account: Account, env: Env) {
  let result = '';
  try {
    const state = await oauthState();
    const browser = await launch(env.BROWSER);
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      await context.addCookies(githubCookies(await decrypt(account.github_cookie, env)));
      const page = await context.newPage();
      await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (await page.locator('#login_field').count()) throw new Error('GitHub cookie is invalid or expired');
      const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${encodeURIComponent(state)}&scope=user:email`;
      let callbackResponse = await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const authorize = page.getByRole('button', { name: /authorize/i }).first();
      if (await authorize.isVisible().catch(() => false)) {
        [callbackResponse] = await Promise.all([
          page.waitForResponse((response) => response.url().includes('/api/oauth/github'), { timeout: 45_000 }),
          authorize.click()
        ]);
      }
      await page.waitForURL(/agentrouter\.org/, { timeout: 45_000 });
      const callbackBody = callbackResponse?.url().includes('/api/oauth/github')
        ? await callbackResponse.json().catch(() => null) as { success?: boolean; message?: string; data?: Record<string, any> } | null
        : null;
      const session = (await context.cookies(BASE)).find((cookie) => cookie.name === 'session');
      const userId = session && sessionUserId(session.value);
      if (userId) await context.setExtraHTTPHeaders({ 'New-Api-User': userId });
      const user = await readSelf(page).catch(() => callbackBody?.data?.user || callbackBody?.data);
      if (!user || callbackBody?.success === false) {
        const detail = `callback=${callbackResponse?.status() || 'none'}, session=${session ? 'yes' : 'no'}`;
        throw new Error(callbackBody?.message || `OAuth callback did not return an authenticated user (${detail})`);
      }
      result = `Success · ${user.display_name || user.username || account.label} · balance $${((Number(user.quota) || 0) / 500000).toFixed(2)}`;
    } finally { await browser.close(); }
  } catch (error) { result = `Failed: ${error instanceof Error ? error.message : String(error)}`; }
  const createdAt = new Date().toISOString();
  const success = result.startsWith('Success');
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET last_claim_at = ?, last_result = ? WHERE id = ?').bind(createdAt, result, account.id),
    env.DB.prepare('INSERT INTO claim_history (account_id, success, result, created_at) VALUES (?, ?, ?, ?)').bind(account.id, success ? 1 : 0, result, createdAt)
  ]);
  return { ok: success, result };
}

async function api(request: Request, env: Env) {
  if (request.headers.get('authorization') !== `Bearer ${env.ACCESS_CODE}`) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/accounts') {
    const { results } = await env.DB.prepare('SELECT id, label, enabled, last_claim_at, last_result FROM accounts ORDER BY id DESC').all();
    return json(results);
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    const { results } = await env.DB.prepare('SELECT h.id, a.label, h.success, h.result, h.created_at FROM claim_history h JOIN accounts a ON a.id = h.account_id ORDER BY h.id DESC LIMIT 100').all();
    return json(results);
  }
  if (request.method === 'POST' && url.pathname === '/api/accounts') {
    const body = await request.json<{ label?: string; githubCookie?: string }>();
    if (!body.label?.trim() || !body.githubCookie?.includes('=')) return json({ error: 'Label and GitHub cookie are required' }, 400);
    await env.DB.prepare('INSERT INTO accounts (label, github_cookie) VALUES (?, ?)').bind(body.label.trim(), await encrypt(body.githubCookie, env)).run();
    return json({ ok: true }, 201);
  }
  const match = url.pathname.match(/^\/api\/accounts\/(\d+)(?:\/(claim))?$/);
  if (match && request.method === 'DELETE' && !match[2]) { await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(match[1]).run(); return json({ ok: true }); }
  if (match && request.method === 'POST' && match[2]) {
    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(match[1]).first<Account>();
    return account ? json(await claim(account, env)) : json({ error: 'Account not found' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  fetch(request: Request, env: Env) { return new URL(request.url).pathname.startsWith('/api/') ? api(request, env) : env.ASSETS.fetch(request); },
  async scheduled(_controller: ScheduledController, env: Env) {
    const { results } = await env.DB.prepare('SELECT * FROM accounts WHERE enabled = 1').all<Account>();
    for (const account of results) await claim(account, env);
  }
} satisfies ExportedHandler<Env>;
