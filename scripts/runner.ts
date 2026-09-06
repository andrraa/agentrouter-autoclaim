import { chromium, type BrowserContext, type Page } from 'playwright';

const BASE = 'https://agentrouter.org';
const CLIENT_ID = 'Ov23lidtiR4LeVZvVRNL';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const ACCESS_CODE = process.env.ACCESS_CODE || '';

if (!WORKER_URL || !ACCESS_CODE) {
  console.error('Error: WORKER_URL and ACCESS_CODE environment variables are required.');
  process.exit(1);
}

function githubCookies(header: string) {
  const cookies = new Map<string, { name: string; value: string; domain: string; path: string }>();
  for (const part of header.replace(/[\r\n\t]+/g, ' ').split(';').map((v) => v.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (at > 0 && name && value && !/[\s={}?&]/.test(name)) {
      cookies.set(name, { name, value, domain: '.github.com', path: '/' });
    }
  }
  return [...cookies.values()];
}

async function addGithubCookies(context: BrowserContext, header: string) {
  const cookies = githubCookies(header);
  for (const cookie of cookies) {
    await context.addCookies([cookie]).catch(() => undefined);
  }
}

async function getInPageOAuthState(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await page.evaluate(async (url) => {
        const r = await fetch(url, { headers: { accept: 'application/json, text/plain, */*' } });
        return r.json().catch(() => null);
      }, `${BASE}/api/oauth/state`) as { success?: boolean; data?: string } | null;

      if (res?.success && res.data) return String(res.data);
    } catch { /* wait for WAF challenge to settle */ }
    await page.waitForTimeout(2000);
  }
  throw new Error('Failed to retrieve OAuth state from AgentRouter page context');
}

async function pureHttpClaim(rawCookie: string, label: string) {
  const response = await fetch(`${BASE}/api/oauth/state`, {
    headers: { accept: 'application/json, text/plain, */*', origin: BASE, referer: `${BASE}/login`, 'user-agent': USER_AGENT }
  });
  const text = await response.text();
  let stateRes: { success?: boolean; data?: string } | null = null;
  try { stateRes = JSON.parse(text); } catch {
    throw new Error('Pure HTTP state blocked by WAF');
  }
  if (!stateRes?.success || !stateRes.data) throw new Error('Failed to obtain state via pure HTTP');
  const state = stateRes.data;

  const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${encodeURIComponent(state)}&scope=user:email`;
  const ghRes = await fetch(authUrl, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Cookie: rawCookie, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'manual'
  });

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
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: rawCookie },
        body: new URLSearchParams({ authenticity_token: tokenMatch[1], client_id: CLIENT_ID, state, scope: 'user:email', authorize: '1' }).toString(),
        redirect: 'manual'
      });
      const postLoc = postRes.headers.get('location') || '';
      try { code = new URL(postLoc, 'https://github.com').searchParams.get('code'); } catch { /* ignore */ }
    }
  }

  if (!code) throw new Error('Failed to obtain OAuth authorization code from GitHub');

  const cbRes = await fetch(`${BASE}/api/oauth/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', Referer: `${BASE}/login`, Origin: BASE }
  });

  const body = await cbRes.json<{ success?: boolean; message?: string; data?: Record<string, any> }>().catch(() => null);
  if (body?.success && body.data) {
    const u = body.data.user || body.data;
    return `Success (HTTP) · ${u.display_name || u.username || label}`;
  }
  if (cbRes.status === 200 && !body?.message) {
    return `Success (HTTP) · ${label}`;
  }
  throw new Error(body?.message || `HTTP OAuth returned ${cbRes.status}`);
}

async function browserClaim(rawCookie: string, label: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    await addGithubCookies(context, rawCookie);
    const page = await context.newPage();

    // 1. Open AgentRouter login to allow WAF challenge to execute
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);

    // 2. Fetch OAuth state from page context
    const state = await getInPageOAuthState(page);

    // 3. Visit GitHub to ensure session is primed
    await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (await page.locator('#login_field').count()) throw new Error('GitHub cookie is invalid or expired');

    // 4. Navigate to GitHub OAuth authorize
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${encodeURIComponent(state)}&scope=user:email`;
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // 5. Click Authorize if consent screen is shown
    const authorize = page.getByRole('button', { name: /authorize/i }).first();
    if (await authorize.isVisible().catch(() => false)) {
      await authorize.click();
    }

    // 6. Wait for redirect back to AgentRouter
    await page.waitForURL(/agentrouter\.org/, { timeout: 45_000 });
    await page.waitForTimeout(3000);

    // 7. Get user data from console
    const userRes = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      return res.json().catch(() => null);
    }, `${BASE}/api/user/self`).catch(() => null) as { success?: boolean; data?: Record<string, any> } | null;

    if (userRes?.success && userRes.data) {
      const u = userRes.data;
      return `Success (GH Runner) · ${u.display_name || u.username || label}`;
    }

    return `Success (GH Runner) · ${label}`;
  } finally {
    await browser.close();
  }
}

async function run() {
  console.log(`Connecting to worker at ${WORKER_URL}…`);
  const res = await fetch(`${WORKER_URL}/api/runner/accounts`, {
    headers: { Authorization: `Bearer ${ACCESS_CODE}` }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch accounts from worker: HTTP ${res.status}`);
  }

  const accounts = await res.json<{ id: number; label: string; githubCookie: string }[]>();
  console.log(`Found ${accounts.length} active account(s).\n`);

  for (const acc of accounts) {
    console.log(`Processing [${acc.label}]…`);
    let result = '';
    try {
      result = await pureHttpClaim(acc.githubCookie, acc.label);
      console.log(`  -> ${result}`);
    } catch (httpErr) {
      console.log(`  -> Pure HTTP failed (${httpErr instanceof Error ? httpErr.message : String(httpErr)}), launching Playwright browser…`);
      try {
        result = await browserClaim(acc.githubCookie, acc.label);
        console.log(`  -> ${result}`);
      } catch (browserErr) {
        result = `Failed: ${browserErr instanceof Error ? browserErr.message : String(browserErr)}`;
        console.error(`  -> ${result}`);
      }
    }

    // Report back to worker
    await fetch(`${WORKER_URL}/api/runner/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_CODE}` },
      body: JSON.stringify({ id: acc.id, result })
    }).catch((err) => console.error('  -> Failed to report back to worker:', err));
  }

  console.log('\nAll accounts processed.');
}

run().catch((err) => {
  console.error('Runner error:', err);
  process.exit(1);
});
