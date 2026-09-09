import { validEmail, validPassword, type Credentials } from './credentials';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_CODE: string;
  ENCRYPTION_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GH_ACTIONS_TOKEN?: string;
}
type Account = { id: number; label: string; credentials: string | null; enabled: number; last_claim_at?: string; last_result?: string };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

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
async function readCredentials(value: string, env: Env): Promise<Credentials> {
  const credentials = JSON.parse(await decrypt(value, env));
  if (!validEmail(credentials?.email) || !validPassword(credentials?.password)) throw new Error('Invalid stored credentials');
  return { email: credentials.email, password: credentials.password };
}

function formatWibDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return `${formatter.format(date).replace(/\./g, ':')} WIB`;
}

async function notifyTelegram(env: Env, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID.trim(),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    console.log('[telegram] delivery', { status: res.status });
  } catch { console.error('[telegram] delivery failed'); }
}

async function recordResult(env: Env, account: { id: number; label: string }, result: string) {
  const createdAt = new Date().toISOString();
  const success = result.startsWith('Success');
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET last_claim_at = ?, last_result = ? WHERE id = ?').bind(createdAt, result, account.id),
    env.DB.prepare('INSERT INTO claim_history (account_id, success, result, created_at) VALUES (?, ?, ?, ?)').bind(account.id, success ? 1 : 0, result, createdAt)
  ]);
  const statusEmoji = success ? '✅' : '❌';
  const statusText = success ? 'Success' : 'Failed';
  const timeWib = formatWibDate(new Date(createdAt));
  const message = [
    `<b>${statusEmoji} AgentRouter Auto-Claim</b>`,
    ``,
    `<b>Account:</b> <code>${account.label}</code>`,
    `<b>Status:</b> ${statusText}`,
    `<b>Detail:</b> ${result}`,
    `<b>Time:</b> ${timeWib}`
  ].join('\n');
  await notifyTelegram(env, message);
}

// Manual claim runs the same email/password login/logout flow from the Worker.
// ponytail: no Turnstile handling here; if AgentRouter turns the challenge on, use the GH Actions runner.
const AR_BASE = 'https://agentrouter.org';
const AR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
type ArJson = { success?: boolean; message?: string; data?: { id?: number; checked_in?: boolean } } | null;

async function arFetch(path: string, init: RequestInit = {}, cookie?: string): Promise<{ res: Response; body: ArJson; cookie: string }> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', AR_UA);
  headers.set('accept', 'application/json, text/plain, */*');
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(`${AR_BASE}${path}`, { ...init, headers });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const merged = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { res, body: (await res.json().catch(() => null)) as ArJson, cookie: merged || cookie || '' };
}

async function manualClaim(env: Env, account: Account): Promise<string> {
  const credentials = await readCredentials(account.credentials!, env);
  const { res: loginRes, body: loginBody, cookie } = await arFetch('/api/user/login?turnstile=', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: AR_BASE, referer: `${AR_BASE}/login` },
    body: JSON.stringify({ username: credentials.email, password: credentials.password })
  });
  if (loginRes.status !== 200 || loginBody?.success !== true) {
    throw new Error(loginBody?.message || 'AgentRouter login rejected or challenge required');
  }
  const userId = loginBody.data?.id;
  if (!Number.isSafeInteger(userId) || userId! <= 0) throw new Error('Login did not return an authenticated user');

  const authHeaders = { 'New-Api-User': String(userId), origin: AR_BASE, referer: `${AR_BASE}/console` };
  const { res: selfRes, body: selfBody } = await arFetch('/api/user/self', { headers: authHeaders }, cookie);
  const verified = selfRes.status === 200 && selfBody?.success === true && selfBody.data?.id === userId;
  const checkedIn = selfBody?.data?.checked_in === true;

  const { res: logoutRes, body: logoutBody } = await arFetch('/api/user/logout', { headers: authHeaders }, cookie);
  const loggedOut = logoutRes.status === 200 && logoutBody?.success === true;

  if (!verified) throw new Error('AgentRouter session verification failed');
  if (!loggedOut) throw new Error('AgentRouter logout failed');
  return checkedIn
    ? 'Success (Manual) · Login/logout verified · Already checked in today'
    : 'Success (Manual) · Login/logout verified · Check-in recorded';
}

async function api(request: Request, env: Env) {
  if (!env.ACCESS_CODE || request.headers.get('authorization') !== `Bearer ${env.ACCESS_CODE}`) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/runner/trigger') {
    try {
      await triggerGithubActions(env);
      return json({ ok: true, message: 'GitHub workflow dispatch accepted' }, 202);
    } catch { return json({ error: 'GitHub dispatch failed. Check Worker logs.' }, 502); }
  }
  if (request.method === 'GET' && url.pathname === '/api/runner/accounts') {
    const { results } = await env.DB.prepare('SELECT id, label, credentials FROM accounts WHERE enabled = 1 AND credentials IS NOT NULL').all<Account>();
    return json(await Promise.all(results.map(async (acc) => ({ id: acc.id, label: acc.label, ...await readCredentials(acc.credentials!, env) }))));
  }
  if (request.method === 'POST' && url.pathname === '/api/runner/report') {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (!body || !Number.isSafeInteger(body.id) || Number(body.id) <= 0 || typeof body.result !== 'string' || !body.result || body.result.length > 1000) return json({ error: 'Invalid id or result' }, 400);
    const account = await env.DB.prepare('SELECT id, label FROM accounts WHERE id = ?').bind(body.id).first<{ id: number; label: string }>();
    if (!account) return json({ error: 'Account not found' }, 404);
    await recordResult(env, account, body.result);
    return json({ ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/accounts') {
    const { results } = await env.DB.prepare('SELECT id, label, credentials, enabled, last_claim_at, last_result FROM accounts ORDER BY id DESC').all<Account>();
    return json(await Promise.all(results.map(async ({ credentials, ...account }) => ({
      ...account, email: credentials ? (await readCredentials(credentials, env)).email : '', needsCredentials: !credentials
    }))));
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    const { results } = await env.DB.prepare(
      'SELECT h.id, a.label, h.success, h.result, h.created_at FROM claim_history h JOIN accounts a ON a.id = h.account_id WHERE h.id IN (SELECT MAX(id) FROM claim_history GROUP BY account_id) ORDER BY h.id DESC'
    ).all();
    return json(results);
  }
  const match = url.pathname.match(/^\/api\/accounts\/(\d+)(?:\/(claim))?$/);
  const creating = request.method === 'POST' && url.pathname === '/api/accounts';
  const editing = match && !match[2] && (request.method === 'PUT' || request.method === 'PATCH');
  if (creating || editing) {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 100) return json({ error: 'Account label is required (maximum 100 characters)' }, 400);
    const email = typeof body.email === 'string' ? body.email.trim() : body.email;
    if (!validEmail(email)) return json({ error: 'Valid AgentRouter email is required' }, 400);
    if (body.password !== undefined && body.password !== '' && !validPassword(body.password)) return json({ error: 'Invalid password (maximum 1024 characters)' }, 400);
    const existing = editing ? await env.DB.prepare('SELECT id, credentials FROM accounts WHERE id = ?').bind(match![1]).first<Account>() : null;
    if (editing && !existing) return json({ error: 'Account not found' }, 404);
    let password = body.password;
    if (password === '' || password === undefined) {
      if (!existing?.credentials) return json({ error: 'AgentRouter password is required' }, 400);
      const previous = await readCredentials(existing.credentials, env);
      if (email !== previous.email) return json({ error: 'Password is required when changing email' }, 400);
      password = previous.password;
    }
    const encrypted = await encrypt(JSON.stringify({ email, password }), env);
    if (creating) {
      await env.DB.prepare('INSERT INTO accounts (label, credentials) VALUES (?, ?)').bind(body.label.trim(), encrypted).run();
    } else {
      await env.DB.prepare('UPDATE accounts SET label = ?, credentials = ? WHERE id = ?').bind(body.label.trim(), encrypted, match![1]).run();
    }
    return json({ ok: true }, creating ? 201 : 200);
  }
  if (match && request.method === 'DELETE' && !match[2]) {
    await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(match[1]).run();
    return json({ ok: true });
  }
  if (match && request.method === 'POST' && match[2]) {
    try {
      const account = await env.DB.prepare('SELECT id, label, credentials FROM accounts WHERE id = ?').bind(match[1]).first<Account>();
      if (!account) return json({ error: 'Account not found' }, 404);
      if (!account.credentials) return json({ error: 'Account has no stored credentials. Edit the account first.' }, 400);
      const result = await manualClaim(env, account);
      await recordResult(env, account, result);
      return json({ ok: true, result });
    } catch (error) {
      const detail = (error as Error).message || 'Manual claim failed';
      try {
        const account = await env.DB.prepare('SELECT id, label FROM accounts WHERE id = ?').bind(match[1]).first<Account>();
        if (account) await recordResult(env, account, `Failed: ${detail}`);
      } catch { /* keep claim error as the response */ }
      return json({ error: detail }, 502);
    }
  }
  return json({ error: 'Not found' }, 404);
}

async function triggerGithubActions(env: Env) {
  if (!env.GH_ACTIONS_TOKEN) throw new Error('GH_ACTIONS_TOKEN is missing');
  const response = await fetch('https://api.github.com/repos/andrraa/agentrouter-autoclaim/actions/workflows/claim.yml/dispatches', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_ACTIONS_TOKEN}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'agentrouter-autoclaim', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: 'main' })
  });
  console.log('[cron] GitHub dispatch', { status: response.status });
  if (response.status !== 204) throw new Error(`GitHub dispatch failed: HTTP ${response.status}`);
}

export default {
  async scheduled(_event: ScheduledController, env: Env) { await triggerGithubActions(env); },
  async fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await api(request, env); }
    catch (e) { console.error('[api] request failed:', e); return json({ error: 'Internal request failure' }, 500); }
  }
} satisfies ExportedHandler<Env>;
