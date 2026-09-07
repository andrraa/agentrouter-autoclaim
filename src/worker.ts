import { launch, type BrowserWorker } from '@cloudflare/playwright';
import { parseCookieString, serializeCookieMap, mergeSetCookies, captureGithubCookies } from './cookies';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BROWSER: BrowserWorker;
  ACCESS_CODE: string;
  ENCRYPTION_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}
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
  return [...parseCookieString(header)].map(([name, value]) => ({ name, value, url: 'https://github.com' }));
}
async function addGithubCookies(context: import('@cloudflare/playwright').BrowserContext, header: string) {
  const cookies = githubCookies(header);
  if (!cookies.some((cookie) => cookie.name === 'user_session')) throw new Error('GitHub cookie must include user_session');
  await context.addCookies(cookies);
}
async function waitForSession(context: import('@cloudflare/playwright').BrowserContext) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const session = (await context.cookies(BASE)).find((cookie) => cookie.name === 'session');
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}
async function oauthState(page?: import('@cloudflare/playwright').Page, sessionCookies = new Map<string, string>()) {
  if (page) {
    const fromPage = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      return res.json().catch(() => null);
    }, `${BASE}/api/oauth/state`).catch(() => null) as { success?: boolean; data?: string } | null;
    if (fromPage?.success && fromPage.data) return fromPage.data;
  }

  if (page) throw new Error('Failed to get OAuth state in browser session');
  const response = await fetch(`${BASE}/api/oauth/state`, {
    headers: { accept: 'application/json, text/plain, */*', origin: BASE, referer: `${BASE}/login`, 'user-agent': USER_AGENT }
  });
  mergeSetCookies(sessionCookies, response);
  const text = await response.text();
  let body: { success?: boolean; data?: string; message?: string } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('AgentRouter OAuth state returned HTML (WAF block)');
  }
  if (!body?.success || !body.data) throw new Error(body?.message || 'Failed to get OAuth state');
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
async function pureHttpClaim(cookies: Map<string, string>, label: string) {
  const sessionCookies = new Map<string, string>();
  const state = await oauthState(undefined, sessionCookies);
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${encodeURIComponent(state)}&scope=user:email`;
  const ghRes = await fetch(authUrl, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Cookie: serializeCookieMap(cookies), Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'manual'
  });

  mergeSetCookies(cookies, ghRes);
  let code: string | null = null;
  const loc = ghRes.headers.get('location') || '';
  if ((ghRes.status === 301 || ghRes.status === 302) && loc) {
    if (loc.includes('/login')) throw new Error('GitHub cookie invalid or expired');
    try { code = new URL(loc, 'https://github.com').searchParams.get('code'); } catch { /* ignore */ }
  } else if (ghRes.status === 200) {
    const html = await ghRes.text();
    if (html.includes('id="login_field"') || html.includes('action="/session"')) throw new Error('GitHub cookie invalid or expired');
    const tokenMatch = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
    if (tokenMatch?.[1]) {
      const postRes = await fetch('https://github.com/login/oauth/authorize', {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: serializeCookieMap(cookies) },
        body: new URLSearchParams({ authenticity_token: tokenMatch[1], client_id: CLIENT_ID, state, scope: 'user:email', authorize: '1' }).toString(),
        redirect: 'manual'
      });
      mergeSetCookies(cookies, postRes);
      const postLoc = postRes.headers.get('location') || '';
      try { code = new URL(postLoc, 'https://github.com').searchParams.get('code'); } catch { /* ignore */ }
    }
  }

  if (!code) throw new Error('Failed to obtain OAuth authorization code from GitHub');

  const cbRes = await fetch(`${BASE}/api/oauth/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', Referer: `${BASE}/login`, Origin: BASE, Cookie: serializeCookieMap(sessionCookies) }
  });

  const body = await cbRes.json<{ success?: boolean; message?: string; data?: Record<string, any> }>().catch(() => null);
  if (body?.success && body.data) {
    const u = body.data.user || body.data;
    const accountName = u.display_name || u.username || label;
    return `Success (HTTP) · ${accountName}`;
  }
  if (body?.success === true) {
    return `Success (HTTP) · ${label}`;
  }
  throw new Error(body?.message || `HTTP OAuth returned ${cbRes.status}`);
}

async function notifyTelegram(env: Env, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, error: 'Telegram credentials missing' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID.trim(),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json<{ ok?: boolean; description?: string }>().catch(() => null);
    if (!res.ok || !body?.ok) {
      console.error('[Telegram API error]', res.status, body);
      return { ok: false, error: body?.description || `HTTP ${res.status}` };
    }
    return { ok: true, data: body };
  } catch (err) {
    console.error('[Telegram notification error]', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function claim(account: Account, env: Env) {
  let result = '';
  const rawCookie = await decrypt(account.github_cookie, env);
  const cookies = parseCookieString(rawCookie);
  const originalCookie = serializeCookieMap(cookies);
  try {
    result = await pureHttpClaim(cookies, account.label);
  } catch (httpError) {
    console.log(`[Pure HTTP fallback to browser] ${httpError instanceof Error ? httpError.message : String(httpError)}`);
    try {
      const browser = await launch(env.BROWSER);
      let context: import('@cloudflare/playwright').BrowserContext | undefined;
      let seeded = false;
      try {
        context = await browser.newContext({ userAgent: USER_AGENT });
        await addGithubCookies(context, serializeCookieMap(cookies));
        seeded = true;
        const page = await context.newPage();
        await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        const state = await oauthState(page);
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
        const callbackBody = callbackResponse?.url().includes('/api/oauth/github')
          ? await callbackResponse.json().catch(() => null) as { success?: boolean; message?: string; data?: Record<string, any> } | null
          : null;
        const session = await waitForSession(context);
        const userId = session && sessionUserId(session.value);
        if (userId) await context.setExtraHTTPHeaders({ 'New-Api-User': userId });
        const user = await readSelf(page).catch(() => callbackBody?.data?.user || callbackBody?.data);
        if (callbackBody?.success === false) throw new Error(callbackBody.message || 'OAuth callback failed');
        if (!user) {
          if (callbackResponse?.status() === 200 && session) {
            result = `Success (Browser) · ${account.label}`;
          } else {
            const detail = `callback=${callbackResponse?.status() || 'none'}, session=${session ? 'yes' : 'no'}`;
            throw new Error(`OAuth callback did not return an authenticated user (${detail})`);
          }
        } else {
          const accountName = user.display_name || user.username || account.label;
          result = `Success (Browser) · ${accountName}`;
        }
      } finally {
        try {
          if (context && seeded) await captureGithubCookies(cookies, context);
        } finally { await browser.close(); }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = `Failed: ${/429|rate limit/i.test(message) ? 'Cloudflare Browser Rendering rate limit exceeded; wait before retrying' : message.replace(/(user_session|_gh_sess)=[^;\s]+/g, '$1=[redacted]')}`;
    }
  }
  const createdAt = new Date().toISOString();
  const success = result.startsWith('Success');
  const dbOps = [
    env.DB.prepare('UPDATE accounts SET last_claim_at = ?, last_result = ? WHERE id = ?').bind(createdAt, result, account.id),
    env.DB.prepare('INSERT INTO claim_history (account_id, success, result, created_at) VALUES (?, ?, ?, ?)').bind(account.id, success ? 1 : 0, result, createdAt)
  ];
  const updatedCookie = serializeCookieMap(cookies);
  if (updatedCookie !== originalCookie) {
    dbOps.push(env.DB.prepare('UPDATE accounts SET github_cookie = ? WHERE id = ? AND github_cookie = ?')
      .bind(await encrypt(updatedCookie, env), account.id, account.github_cookie));
  }
  await env.DB.batch(dbOps);
  const emoji = success ? '✅' : '❌';
  const timeStr = new Date(createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  await notifyTelegram(env, `<b>${emoji} AgentRouter Claim</b>\n<b>Account:</b> ${account.label}\n<b>Status:</b> ${result}\n<b>Time:</b> ${timeStr} WIB`);
  return { ok: success, result };
}

async function api(request: Request, env: Env) {
  if (request.headers.get('authorization') !== `Bearer ${env.ACCESS_CODE}`) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/runner/accounts') {
    const { results } = await env.DB.prepare('SELECT id, label, github_cookie, enabled FROM accounts WHERE enabled = 1').all<Account>();
    const decrypted = await Promise.all(
      results.map(async (acc) => ({
        id: acc.id,
        label: acc.label,
        githubCookie: await decrypt(acc.github_cookie, env)
      }))
    );
    return json(decrypted);
  }
  if (request.method === 'POST' && url.pathname === '/api/runner/report') {
    const body = await request.json<{ id?: number; result?: string; updatedCookie?: string }>();
    if (!body.id || !body.result) return json({ error: 'Missing id or result' }, 400);
    const account = await env.DB.prepare('SELECT id, label FROM accounts WHERE id = ?').bind(body.id).first<{ id: number; label: string }>();
    if (!account) return json({ error: 'Account not found' }, 404);
    const createdAt = new Date().toISOString();
    const success = body.result.startsWith('Success');

    const dbOps = [
      env.DB.prepare('UPDATE accounts SET last_claim_at = ?, last_result = ? WHERE id = ?').bind(createdAt, body.result, account.id),
      env.DB.prepare('INSERT INTO claim_history (account_id, success, result, created_at) VALUES (?, ?, ?, ?)').bind(account.id, success ? 1 : 0, body.result, createdAt)
    ];

    if (typeof body.updatedCookie === 'string' && (!body.updatedCookie || body.updatedCookie.includes('='))) {
      const encrypted = await encrypt(body.updatedCookie, env);
      dbOps.push(env.DB.prepare('UPDATE accounts SET github_cookie = ? WHERE id = ?').bind(encrypted, account.id));
    }

    await env.DB.batch(dbOps);
    const emoji = success ? '✅' : '❌';
    const timeStr = new Date(createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    await notifyTelegram(env, `<b>${emoji} AgentRouter Claim</b>\n<b>Account:</b> ${account.label}\n<b>Status:</b> ${body.result}\n<b>Time:</b> ${timeStr} WIB`);
    return json({ ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/accounts') {
    const { results } = await env.DB.prepare('SELECT id, label, enabled, last_claim_at, last_result FROM accounts ORDER BY id DESC').all();
    return json(results);
  }
    if (request.method === 'POST' && url.pathname === '/api/telegram/test') {
    const res = await notifyTelegram(env, '<b>AgentRouter Test Notification</b>\nTelegram integration is working!');
    return json(res);
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    const { results } = await env.DB.prepare(
      'SELECT h.id, a.label, h.success, h.result, h.created_at FROM claim_history h JOIN accounts a ON a.id = h.account_id WHERE h.id IN (SELECT MAX(id) FROM claim_history GROUP BY account_id) ORDER BY h.id DESC'
    ).all();
    return json(results);
  }
  if (request.method === 'POST' && url.pathname === '/api/accounts') {
    const body = await request.json<{ label?: string; githubCookie?: string }>();
    if (!body.label?.trim() || !body.githubCookie?.includes('=')) return json({ error: 'Label and GitHub cookie are required' }, 400);
    await env.DB.prepare('INSERT INTO accounts (label, github_cookie) VALUES (?, ?)').bind(body.label.trim(), await encrypt(body.githubCookie, env)).run();
    return json({ ok: true }, 201);
  }
  const match = url.pathname.match(/^\/api\/accounts\/(\d+)(?:\/(claim))?$/);
  if (match && (request.method === 'PUT' || request.method === 'PATCH') && !match[2]) {
    const body = await request.json<{ label?: string; githubCookie?: string }>();
    if (!body.label?.trim()) return json({ error: 'Account label is required' }, 400);
    if (body.githubCookie?.trim()) {
      if (!body.githubCookie.includes('=')) return json({ error: 'GitHub cookie must contain valid key=value pairs' }, 400);
      const encrypted = await encrypt(body.githubCookie.trim(), env);
      await env.DB.prepare('UPDATE accounts SET label = ?, github_cookie = ? WHERE id = ?').bind(body.label.trim(), encrypted, match[1]).run();
    } else {
      await env.DB.prepare('UPDATE accounts SET label = ? WHERE id = ?').bind(body.label.trim(), match[1]).run();
    }
    return json({ ok: true });
  }
  if (match && request.method === 'DELETE' && !match[2]) { await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(match[1]).run(); return json({ ok: true }); }
  if (match && request.method === 'POST' && match[2]) {
    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(match[1]).first<Account>();
    return account ? json(await claim(account, env)) : json({ error: 'Account not found' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  fetch(request: Request, env: Env) { return new URL(request.url).pathname.startsWith('/api/') ? api(request, env) : env.ASSETS.fetch(request); }
} satisfies ExportedHandler<Env>;
